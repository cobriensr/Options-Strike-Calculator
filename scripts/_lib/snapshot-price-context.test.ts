// @vitest-environment node

/**
 * Pure parts of the snapshot price-context backfill (scripts/_lib/
 * snapshot-price-context.ts): the 2-decimal rounding, `planDate` (which row
 * gets what, and why a row or a whole date is skipped), the feature-pick
 * report, the reading of a /api/history response, the argument parsing, the
 * printed reports, the reconciliation of the row counts and the exit codes.
 * The SQL, the plan, undo and apply-report files and the run are covered on
 * real Postgres in snapshot-price-context-pglite.test.ts.
 *
 * The module imports `api/cron/build-features.ts` (for `pickFeatureSnapshot`)
 * and the DB client. `db.js` is stubbed so nothing here can reach a database.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
  getDb: () => {
    throw new Error('the pure tests never open a database');
  },
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import { parseEntryTimeMinutes } from '../../src/utils/entry-time.js';
import type { SlotCandle } from '../../src/utils/snapshot-slot.js';
import {
  exitCodeOfApply,
  exitCodeOfDryRun,
  exitCodeOfUndo,
  featurePickChange,
  formatApplyReport,
  formatReport,
  formatUndoReport,
  parseArgs,
  planDate as planDateWith,
  readHistoryResponse,
  reconcile,
  toDecimal2,
  updatesOf,
  type ApplyResult,
  type DateHistory,
  type DatePlan,
  type DryRunResult,
  type PlanResult,
  type SnapshotRowIn,
  type UndoResult,
} from './snapshot-price-context.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const BAR_MS = 5 * 60_000;
const LIVE_DATE = '2026-11-05';
const BACKTEST_DATE = '2026-11-06';
const EARLY_CLOSE_DATE = '2026-11-27';

/** The 9:30 ET bar's start. November is EST, so 9:30 ET is 14:30Z. */
const openMs = (date: string): number => Date.parse(`${date}T14:30:00Z`);

/** The three bars of the Task 3 table, then flat bars inside their range. */
const HEAD: ReadonlyArray<Omit<SlotCandle, 'datetime'>> = [
  { open: 7487, high: 7495, low: 7480, close: 7490 },
  { open: 7490, high: 7502, low: 7488, close: 7500 },
  { open: 7500, high: 7505, low: 7470, close: 7475 },
];
const FLAT = { open: 7475, high: 7476, low: 7474, close: 7475 };

/**
 * The backtest date's session. It opens at 7377.65, the open its replayed rows
 * hold. Through 9:55 ET (bars 0-5) the high is 7388 and the low 7372. The bar
 * that starts at 10:00 ET (bar 6) reaches 7390.10 and 7370.20: the peek a row
 * at 9:00 AM CT took when it was replayed.
 */
const BACKTEST_HEAD: ReadonlyArray<Omit<SlotCandle, 'datetime'>> = [
  { open: 7377.65, high: 7385, low: 7372, close: 7380 },
  { open: 7380, high: 7388, low: 7375, close: 7386 },
  { open: 7386, high: 7387, low: 7378, close: 7380 },
  { open: 7380, high: 7384, low: 7376, close: 7379 },
  { open: 7379, high: 7383, low: 7377, close: 7381 },
  { open: 7381, high: 7384, low: 7379, close: 7382 },
  { open: 7382, high: 7390.1, low: 7370.2, close: 7385 },
];
const BACKTEST_FLAT = { open: 7385, high: 7386, low: 7384, close: 7385 };

function session(
  date: string,
  bars = 78,
  tweak: (index: number, candle: SlotCandle) => SlotCandle = (_i, c) => c,
): SlotCandle[] {
  const head = date === BACKTEST_DATE ? BACKTEST_HEAD : HEAD;
  const flat = date === BACKTEST_DATE ? BACKTEST_FLAT : FLAT;
  return Array.from({ length: bars }, (_, i) =>
    tweak(i, {
      datetime: openMs(date) + i * BAR_MS,
      ...(head[i] ?? flat),
    }),
  );
}

const history = (
  date: string,
  previousDay: DateHistory['previousDay'],
  bars = 78,
): DateHistory => ({ candles: session(date, bars), previousDay });

const PRIOR_OF_LIVE = { date: '2026-11-04', close: 7560.87 };
const PRIOR_OF_BACKTEST = { date: '2026-11-05', close: 7356.73 };

/**
 * A row as `readRows` returns it: no price context stored yet, and trusted as
 * far as build-features can tell otherwise (a live save on its own date at its
 * own slot, the spot inside the range a plan would give it).
 */
const row = (
  id: number,
  entryTime: string,
  over: Partial<SnapshotRowIn> = {},
  date = LIVE_DATE,
): SnapshotRowIn => {
  const slot = parseEntryTimeMinutes(entryTime);
  return {
    id,
    date,
    entry_time: entryTime,
    spx: '7490.00',
    spx_open: null,
    spx_high: null,
    spx_low: null,
    prev_close: null,
    overnight_gap: null,
    is_backtest: false,
    flag_reliable: true,
    saved_day_offset: 0,
    // A label with no clock time has no slot to be on time for.
    saved_minutes_ct: Number.isNaN(slot) ? 600 : slot,
    ...over,
  };
};

/** planDate with no outcomes.settlement row for the prior day, unless given. */
const planDate = (
  date: string,
  rows: readonly SnapshotRowIn[],
  hist: DateHistory | null,
  settlement: number | null = null,
) => planDateWith(date, rows, hist, settlement);

const updates = (results: readonly PlanResult[]) =>
  results.flatMap((r) => (r.kind === 'update' ? [r] : []));
const skips = (results: readonly PlanResult[]) =>
  results.flatMap((r) => (r.kind === 'skip' ? [r] : []));

// ── Rounding ────────────────────────────────────────────────────────────────

describe('toDecimal2', () => {
  it.each([
    [7560.87, '7560.87'],
    [7487, '7487.00'],
    [7487.1, '7487.10'],
    [-0.977, '-0.98'],
    [0.28437, '0.28'],
    // Half away from zero, on the decimal text Postgres numeric would read.
    [0.005, '0.01'],
    [-0.005, '-0.01'],
    [2.675, '2.68'],
    [-2.675, '-2.68'],
    [7487.125, '7487.13'],
    // Below half a cent is zero, and numeric has no negative zero.
    [0.004, '0.00'],
    [-0.004, '0.00'],
    [1e-7, '0.00'],
    [-1e-7, '0.00'],
    [0, '0.00'],
    [99999999.99, '99999999.99'],
  ])('%s -> %s', (value, text) => {
    expect(toDecimal2(value)).toBe(text);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1e21])(
    'refuses %s rather than write it',
    (value) => {
      expect(() => toDecimal2(value)).toThrow(RangeError);
    },
  );
});

// ── planDate: which row gets what ───────────────────────────────────────────

describe('planDate: a live row with no stored open', () => {
  const h = history(LIVE_DATE, PRIOR_OF_LIVE);

  it('gets the as-of open, high, low, previous close and gap', () => {
    const plan = planDate(LIVE_DATE, [row(1, '8:35 AM CT')], h);

    expect(plan.skippedDate).toBeUndefined();
    expect(plan.results).toEqual([
      {
        kind: 'update',
        id: 1,
        fill: 'all',
        before: {
          spx_open: null,
          spx_high: null,
          spx_low: null,
          prev_close: null,
          overnight_gap: null,
        },
        after: {
          spx_open: '7487.00',
          spx_high: '7495.00',
          spx_low: '7480.00',
          prev_close: '7560.87',
          // (7487 - 7560.87) / 7560.87 * 100 = -0.97700, rounded once.
          overnight_gap: '-0.98',
        },
      },
    ]);
  });

  it('maps an ET label to the same slot as its CT label', () => {
    const ct = planDate(LIVE_DATE, [row(1, '8:35 AM CT')], h);
    const et = planDate(LIVE_DATE, [row(1, '9:35 AM ET')], h);

    expect(et).toEqual(ct);
    expect(updates(et.results)[0]?.after.spx_high).toBe('7495.00');
  });

  it('knows only the open at 8:30 CT, before any bar has ended', () => {
    const plan = planDate(LIVE_DATE, [row(1, '8:30 AM CT')], h);

    expect(updates(plan.results)[0]?.after).toMatchObject({
      spx_open: '7487.00',
      spx_high: '7487.00',
      spx_low: '7487.00',
    });
  });

  it('keeps the raw stored NaN in `before` and counts it as missing', () => {
    const plan = planDate(
      LIVE_DATE,
      [row(1, '8:35 AM CT', { spx_open: 'NaN' })],
      h,
    );

    const [update] = updates(plan.results);
    expect(update?.fill).toBe('all');
    expect(update?.before.spx_open).toBe('NaN');
    expect(update?.after.spx_open).toBe('7487.00');
  });

  it('counts a stored zero open as missing: it would give a -100% gap', () => {
    const plan = planDate(
      LIVE_DATE,
      [row(1, '8:35 AM CT', { spx_open: '0.00' })],
      h,
    );

    expect(updates(plan.results)[0]).toMatchObject({
      fill: 'all',
      before: { spx_open: '0.00' },
      after: { spx_open: '7487.00' },
    });
  });

  it('gets each slot its own as-of high and low', () => {
    const plan = planDate(
      LIVE_DATE,
      [
        row(1, '8:35 AM CT'),
        row(2, '8:40 AM CT'),
        row(3, '8:45 AM CT'),
        row(4, '10:00 AM CT'),
      ],
      h,
    );

    const highLow = updates(plan.results).map((u) => [
      u.after.spx_high,
      u.after.spx_low,
    ]);
    expect(highLow).toEqual([
      ['7495.00', '7480.00'],
      ['7502.00', '7480.00'],
      ['7505.00', '7470.00'],
      ['7505.00', '7470.00'],
    ]);
  });
});

describe('planDate: a replayed row, which has its open', () => {
  const h = history(BACKTEST_DATE, PRIOR_OF_BACKTEST);
  // What a replay at 9:00 AM CT left: the high and low through the bar that
  // starts at 10:00 ET, which the slot has not seen yet.
  const backtest = row(
    7,
    '9:00 AM CT',
    {
      spx_open: '7377.65',
      spx_high: '7390.10',
      spx_low: '7370.20',
      prev_close: '7720.39',
      overnight_gap: '-4.44',
    },
    BACKTEST_DATE,
  );
  // What the row holds once it is right.
  const right = {
    spx_high: '7388.00',
    spx_low: '7372.00',
    prev_close: '7356.73',
    overnight_gap: '0.28',
  };

  it('gets the high and low as of its slot, and the previous close and gap from its own open', () => {
    const plan = planDate(BACKTEST_DATE, [backtest], h);

    expect(plan.results).toEqual([
      {
        kind: 'update',
        id: 7,
        fill: 'replayed',
        before: {
          spx_high: '7390.10',
          spx_low: '7370.20',
          prev_close: '7720.39',
          overnight_gap: '-4.44',
        },
        // The bar that starts at 10:00 ET is out; (7377.65 - 7356.73) /
        // 7356.73 * 100 = 0.28437, rounded once.
        after: right,
        // The gap, high and low came from this open, so the write is guarded on it.
        guardOpen: '7377.65',
      },
    ]);
  });

  it('carries its own stored open as a guard on a replayed and a close-and-gap update, not on a fill', () => {
    const [filled] = updates(
      planDate(
        LIVE_DATE,
        [row(1, '8:35 AM CT')],
        history(LIVE_DATE, PRIOR_OF_LIVE),
      ).results,
    );
    const [replayed] = updates(planDate(BACKTEST_DATE, [backtest], h).results);

    expect(filled).not.toHaveProperty('guardOpen');
    expect(replayed?.guardOpen).toBe('7377.65');
  });

  it('removes a peeked high alone, and a peeked low alone', () => {
    const peekedHigh = { ...backtest, ...right, spx_high: '7390.10' };
    const peekedLow = { ...backtest, ...right, spx_low: '7370.20' };

    const [high] = updates(planDate(BACKTEST_DATE, [peekedHigh], h).results);
    const [low] = updates(planDate(BACKTEST_DATE, [peekedLow], h).results);

    expect(high).toMatchObject({
      fill: 'replayed',
      before: { spx_high: '7390.10', spx_low: '7372.00' },
      after: { spx_high: '7388.00', spx_low: '7372.00' },
    });
    expect(low).toMatchObject({
      fill: 'replayed',
      before: { spx_high: '7388.00', spx_low: '7370.20' },
      after: { spx_high: '7388.00', spx_low: '7372.00' },
    });
  });

  it('fills a NULL high and low with the values as of the slot, a bar later included', () => {
    // At 9:30 AM CT (10:30 ET) the bar that starts at 10:00 ET has ended.
    const later = row(
      8,
      '9:30 AM CT',
      { spx_open: '7377.65', prev_close: '7356.73', overnight_gap: '0.28' },
      BACKTEST_DATE,
    );

    const [update] = updates(planDate(BACKTEST_DATE, [later], h).results);

    expect(update).toMatchObject({
      fill: 'replayed',
      before: { spx_high: null, spx_low: null },
      after: { spx_high: '7390.10', spx_low: '7370.20' },
    });
  });

  it('knows only the open at 8:30 CT: its high and low are that open', () => {
    const opening = row(
      8,
      '8:30 AM CT',
      {
        spx_open: '7377.65',
        spx_high: '7385.00',
        spx_low: '7372.00',
        prev_close: '7356.73',
        overnight_gap: '0.28',
      },
      BACKTEST_DATE,
    );

    const [update] = updates(planDate(BACKTEST_DATE, [opening], h).results);

    expect(update).toMatchObject({
      fill: 'replayed',
      before: { spx_high: '7385.00', spx_low: '7372.00' },
      after: { spx_high: '7377.65', spx_low: '7377.65' },
    });
  });

  it('is unchanged once all four values equal the rounded plan', () => {
    const done = { ...backtest, ...right };

    expect(planDate(BACKTEST_DATE, [done], h).results).toEqual([
      { kind: 'skip', id: 7, reason: 'unchanged' },
    ]);
  });

  it('does not chase a gap that Postgres stored rounded: -0.977 is -0.98', () => {
    const stored = row(1, '8:35 AM CT', {
      spx_open: '7487.00',
      spx_high: '7495.00',
      spx_low: '7480.00',
      prev_close: '7560.87',
      overnight_gap: '-0.98',
    });

    expect(
      planDate(LIVE_DATE, [stored], history(LIVE_DATE, PRIOR_OF_LIVE)).results,
    ).toEqual([{ kind: 'skip', id: 1, reason: 'unchanged' }]);
  });

  it('writes when only the gap differs', () => {
    const plan = planDate(
      BACKTEST_DATE,
      [{ ...backtest, ...right, overnight_gap: '-4.44' }],
      h,
    );

    expect(updates(plan.results)[0]).toMatchObject({
      before: { spx_high: '7388.00', overnight_gap: '-4.44' },
      after: { spx_high: '7388.00', overnight_gap: '0.28' },
    });
  });

  it('never counts a stored NaN as equal to a plan, not even to 0.00', () => {
    // The previous close equals the open, so the planned gap is exactly 0.00.
    const flat = row(
      8,
      '9:00 AM CT',
      {
        spx_open: '7377.65',
        spx_high: '7388.00',
        spx_low: '7372.00',
        prev_close: '7377.65',
        overnight_gap: 'NaN',
      },
      BACKTEST_DATE,
    );

    const plan = planDate(
      BACKTEST_DATE,
      [flat],
      history(BACKTEST_DATE, { date: '2026-11-05', close: 7377.65 }),
    );

    expect(updates(plan.results)[0]).toMatchObject({
      before: { prev_close: '7377.65', overnight_gap: 'NaN' },
      after: { prev_close: '7377.65', overnight_gap: '0.00' },
    });
  });

  it('plans a NULL previous close and gap too', () => {
    const plan = planDate(
      BACKTEST_DATE,
      [{ ...backtest, ...right, prev_close: null, overnight_gap: null }],
      h,
    );

    expect(updates(plan.results)[0]).toMatchObject({
      before: { prev_close: null, overnight_gap: null },
      after: { prev_close: '7356.73', overnight_gap: '0.28' },
    });
  });
});

describe('planDate: a replayed row whose stored open is not the open as of its slot', () => {
  const h = history(BACKTEST_DATE, PRIOR_OF_BACKTEST);

  it('is skipped as open-mismatch, with both opens, and nothing is planned for it', () => {
    const odd = row(
      11,
      '9:00 AM CT',
      { spx_open: '7400.00', spx_high: '7405.00', prev_close: '7720.39' },
      BACKTEST_DATE,
    );

    const plan = planDate(BACKTEST_DATE, [odd], h);

    expect(plan.results).toEqual([
      {
        kind: 'skip',
        id: 11,
        reason: 'open-mismatch',
        detail: 'stored 7400.00, as of the slot 7377.65',
      },
    ]);
  });

  it('takes an open that agrees at 2 decimals', () => {
    const near: DateHistory = {
      candles: session(BACKTEST_DATE, 78, (i, c) =>
        i === 0 ? { ...c, open: 7377.654 } : c,
      ),
      previousDay: PRIOR_OF_BACKTEST,
    };
    const stored = row(
      11,
      '9:00 AM CT',
      { spx_open: '7377.65' },
      BACKTEST_DATE,
    );

    const plan = planDate(BACKTEST_DATE, [stored], near);

    expect(updates(plan.results)[0]?.fill).toBe('replayed');
  });

  it('takes the gap from the stored open, not from the open as of the slot', () => {
    // 7377.65 and 7377.654 agree at 2 decimals, so the row is taken. Against
    // this previous close the gap is 5.37498 from the stored open (5.37) and
    // 5.37504 from the as-of open (5.38): only the first is what the row's
    // own open gives, and so what its page showed.
    const near: DateHistory = {
      candles: session(BACKTEST_DATE, 78, (i, c) =>
        i === 0 ? { ...c, open: 7377.654 } : c,
      ),
      previousDay: { ...PRIOR_OF_BACKTEST, close: 7001.33 },
    };
    const stored = row(
      11,
      '9:00 AM CT',
      { spx_open: '7377.65' },
      BACKTEST_DATE,
    );

    const plan = planDate(BACKTEST_DATE, [stored], near);

    expect(updates(plan.results)[0]).toMatchObject({
      fill: 'replayed',
      after: { prev_close: '7001.33', overnight_gap: '5.37' },
      guardOpen: '7377.65',
    });
  });

  it('does not stop the rows of the date that agree', () => {
    const plan = planDate(
      BACKTEST_DATE,
      [
        row(11, '9:00 AM CT', { spx_open: '7400.00' }, BACKTEST_DATE),
        row(12, '9:00 AM CT', { spx_open: '7377.65' }, BACKTEST_DATE),
      ],
      h,
    );

    expect(plan.results.map((r) => [r.id, r.kind])).toEqual([
      [11, 'skip'],
      [12, 'update'],
    ]);
  });
});

describe('planDate: a replayed row whose candles are bad', () => {
  // Bar 6 (10:00 ET) has no usable high: a slot after it cannot know the
  // high, so it cannot be rewritten; the slot before it can.
  const broken: DateHistory = {
    candles: session(BACKTEST_DATE, 78, (i, c) =>
      i === 6 ? { ...c, high: Number.NaN } : c,
    ),
    previousDay: PRIOR_OF_BACKTEST,
  };
  const stored = {
    spx_open: '7377.65',
    spx_high: '7390.10',
    spx_low: '7370.20',
    prev_close: '7720.39',
    overnight_gap: '-4.44',
  };

  it('plans only the previous close and gap, and leaves the high and low as stored', () => {
    const plan = planDate(
      BACKTEST_DATE,
      [row(7, '9:10 AM CT', stored, BACKTEST_DATE)],
      broken,
    );

    expect(plan.results).toEqual([
      {
        kind: 'update',
        id: 7,
        fill: 'close-and-gap',
        before: { prev_close: '7720.39', overnight_gap: '-4.44' },
        after: { prev_close: '7356.73', overnight_gap: '0.28' },
        guardOpen: '7377.65',
      },
    ]);
  });

  it('marks the row unchanged, with its high and low left, when its close and gap are right already', () => {
    const plan = planDate(
      BACKTEST_DATE,
      [
        row(
          7,
          '9:10 AM CT',
          { ...stored, prev_close: '7356.73', overnight_gap: '0.28' },
          BACKTEST_DATE,
        ),
      ],
      broken,
    );

    expect(plan.results).toEqual([
      { kind: 'skip', id: 7, reason: 'unchanged', highLowLeft: true },
    ]);
  });

  it('splits a date: the slot before the bad bar is replayed, the slots after it are narrower', () => {
    const plan = planDate(
      BACKTEST_DATE,
      [
        row(7, '9:00 AM CT', stored, BACKTEST_DATE),
        row(8, '9:10 AM CT', stored, BACKTEST_DATE),
        row(9, '9:30 AM CT', stored, BACKTEST_DATE),
      ],
      broken,
    );

    expect(updates(plan.results).map((u) => [u.id, u.fill])).toEqual([
      [7, 'replayed'],
      [8, 'close-and-gap'],
      [9, 'close-and-gap'],
    ]);
  });

  it('does not judge the stored open when there is no as-of open to judge it by', () => {
    const plan = planDate(
      BACKTEST_DATE,
      [row(7, '9:10 AM CT', { ...stored, spx_open: '7400.00' }, BACKTEST_DATE)],
      broken,
    );

    expect(updates(plan.results)[0]?.fill).toBe('close-and-gap');
  });

  it('keeps a row with its open at a candle a column cannot hold: the high and low are left', () => {
    const huge: DateHistory = {
      candles: session(BACKTEST_DATE, 78, (i, c) =>
        i === 6 ? { ...c, high: 1e9 } : c,
      ),
      previousDay: PRIOR_OF_BACKTEST,
    };

    const plan = planDate(
      BACKTEST_DATE,
      [row(7, '9:10 AM CT', stored, BACKTEST_DATE)],
      huge,
    );

    expect(updates(plan.results)[0]?.fill).toBe('close-and-gap');
  });
});

describe('planDate: rows it leaves alone', () => {
  const h = history(LIVE_DATE, PRIOR_OF_LIVE);

  it.each(['pre-market', '', 'sometime', '13:00 AM CT', '9:75 AM CT'])(
    'skips the label %j as no-slot, even with an open stored',
    (label) => {
      const plan = planDate(
        LIVE_DATE,
        [
          row(1, label),
          row(2, label, { spx_open: '7487.00', prev_close: '1.00' }),
        ],
        h,
      );

      expect(plan.results).toEqual([
        { kind: 'skip', id: 1, reason: 'no-slot' },
        { kind: 'skip', id: 2, reason: 'no-slot' },
      ]);
    },
  );

  it('skips a slot before 8:30 CT as before-open, in either zone', () => {
    const plan = planDate(
      LIVE_DATE,
      [
        row(1, '8:29 AM CT'),
        row(2, '9:29 AM ET'),
        row(3, '7:00 AM CT', { spx_open: '7487.00' }),
        row(4, '8:30 AM CT'),
      ],
      h,
    );

    expect(skips(plan.results)).toEqual([
      { kind: 'skip', id: 1, reason: 'before-open' },
      { kind: 'skip', id: 2, reason: 'before-open' },
      { kind: 'skip', id: 3, reason: 'before-open' },
    ]);
    expect(updates(plan.results).map((u) => u.id)).toEqual([4]);
  });

  it('plans each row of a date on its own, in input order', () => {
    const plan = planDate(
      LIVE_DATE,
      [
        row(5, 'pre-market'),
        row(3, '8:35 AM CT'),
        // Right already: the high and low as of 8:40 CT (9:40 ET).
        row(9, '8:40 AM CT', {
          spx_open: '7487.00',
          spx_high: '7502.00',
          spx_low: '7480.00',
          prev_close: '7560.87',
          overnight_gap: '-0.98',
        }),
      ],
      h,
    );

    expect(plan.results.map((r) => [r.kind, r.id])).toEqual([
      ['skip', 5],
      ['update', 3],
      ['skip', 9],
    ]);
  });
});

describe('planDate: bad candles', () => {
  it('splits one date: early slots filled, slots after the bad bar bad-candles', () => {
    // Bar 6 is the 10:00 ET bar. It has ended by 10:10 ET (9:10 CT), not by
    // 10:00 ET (9:00 CT).
    const h: DateHistory = {
      candles: session(LIVE_DATE, 78, (i, c) =>
        i === 6 ? { ...c, high: Number.NaN } : c,
      ),
      previousDay: PRIOR_OF_LIVE,
    };

    const plan = planDate(
      LIVE_DATE,
      [row(1, '9:00 AM CT'), row(2, '9:10 AM CT'), row(3, '9:30 AM CT')],
      h,
    );

    expect(plan.skippedDate).toBeUndefined();
    expect(updates(plan.results).map((u) => u.id)).toEqual([1]);
    expect(skips(plan.results)).toEqual([
      { kind: 'skip', id: 2, reason: 'bad-candles' },
      { kind: 'skip', id: 3, reason: 'bad-candles' },
    ]);
  });

  it('marks every filling row bad-candles when the first bar is not the 9:30 open', () => {
    const h: DateHistory = {
      // 78 bars, the first at 9:35 ET: enough candles, and the wrong open.
      candles: session(LIVE_DATE, 79).slice(1),
      previousDay: PRIOR_OF_LIVE,
    };

    const plan = planDate(
      LIVE_DATE,
      [row(1, '8:35 AM CT'), row(2, '10:00 AM CT')],
      h,
    );

    expect(skips(plan.results).map((s) => s.reason)).toEqual([
      'bad-candles',
      'bad-candles',
    ]);
  });

  it('marks a row bad-candles when a bar carries a non-positive price', () => {
    const h: DateHistory = {
      candles: session(LIVE_DATE, 78, (i, c) =>
        i === 1 ? { ...c, low: 0 } : c,
      ),
      previousDay: PRIOR_OF_LIVE,
    };

    const plan = planDate(
      LIVE_DATE,
      [row(1, '8:35 AM CT'), row(2, '8:40 AM CT')],
      h,
    );

    // Bar 1 (9:35 ET) has ended by 8:40 CT, not by 8:35 CT.
    expect(plan.results.map((r) => [r.kind, r.id])).toEqual([
      ['update', 1],
      ['skip', 2],
    ]);
    expect(skips(plan.results)[0]?.reason).toBe('bad-candles');
  });
});

// ── planDate: why a whole date is skipped ───────────────────────────────────

describe('planDate: a date skipped whole', () => {
  const rows = [row(1, '8:35 AM CT'), row(2, '9:00 AM CT')];

  it.each([
    ['a Saturday', '2026-11-07'],
    ['a Sunday', '2026-11-08'],
    ['Thanksgiving', '2026-11-26'],
    ['Independence Day observed', '2026-07-03'],
  ])(
    'is not-a-trading-day for %s, with or without a history, before anything else',
    (_name, date) => {
      const day = [row(1, '8:35 AM CT', {}, date)];

      expect(planDate(date, day, null)).toEqual({
        results: [],
        skippedDate: 'not-a-trading-day',
      });
      expect(
        planDate(date, day, history(date, { date: '2026-11-04', close: 7500 })),
      ).toEqual({ results: [], skippedDate: 'not-a-trading-day' });
    },
  );

  it('keeps an early-close day a trading day', () => {
    const plan = planDate(
      EARLY_CLOSE_DATE,
      [row(1, '8:35 AM CT', {}, EARLY_CLOSE_DATE)],
      history(EARLY_CLOSE_DATE, { date: '2026-11-25', close: 7600.5 }, 42),
    );

    expect(plan.skippedDate).toBeUndefined();
  });

  it('is no-history without a history', () => {
    expect(planDate(LIVE_DATE, rows, null)).toEqual({
      results: [],
      skippedDate: 'no-history',
    });
  });

  it('is short-candles with 77 candles on a full day', () => {
    expect(
      planDate(LIVE_DATE, rows, history(LIVE_DATE, PRIOR_OF_LIVE, 77)),
    ).toEqual({ results: [], skippedDate: 'short-candles' });
  });

  it('is short-candles with no candles at all', () => {
    expect(
      planDate(LIVE_DATE, rows, history(LIVE_DATE, PRIOR_OF_LIVE, 0)),
    ).toEqual({ results: [], skippedDate: 'short-candles' });
  });

  it('takes 78 candles on a full day, and more (duplicates) as well', () => {
    for (const bars of [78, 80]) {
      const plan = planDate(
        LIVE_DATE,
        rows,
        history(LIVE_DATE, PRIOR_OF_LIVE, bars),
      );
      expect(plan.skippedDate).toBeUndefined();
      expect(updates(plan.results)).toHaveLength(2);
    }
  });

  it('needs only 42 candles on an early-close day, and not 41', () => {
    const prior = { date: '2026-11-25', close: 7600.5 };
    const day = [row(1, '8:35 AM CT', {}, EARLY_CLOSE_DATE)];

    const full = planDate(
      EARLY_CLOSE_DATE,
      day,
      history(EARLY_CLOSE_DATE, prior, 42),
    );
    expect(full.skippedDate).toBeUndefined();
    expect(updates(full.results)).toHaveLength(1);

    expect(
      planDate(EARLY_CLOSE_DATE, day, history(EARLY_CLOSE_DATE, prior, 41)),
    ).toEqual({ results: [], skippedDate: 'short-candles' });
  });

  it.each([
    ['no previous day at all', null],
    ['a previous day two sessions back', { date: '2026-11-03', close: 7600 }],
    ['the target date itself', { date: LIVE_DATE, close: 7600 }],
    ['a close of 0', { date: '2026-11-04', close: 0 }],
    ['a negative close', { date: '2026-11-04', close: -7560.87 }],
    ['a NaN close', { date: '2026-11-04', close: Number.NaN }],
    [
      'an infinite close',
      { date: '2026-11-04', close: Number.POSITIVE_INFINITY },
    ],
  ])('is no-previous-day with %s', (_name, previousDay) => {
    expect(planDate(LIVE_DATE, rows, history(LIVE_DATE, previousDay))).toEqual({
      results: [],
      skippedDate: 'no-previous-day',
    });
  });

  it('takes the prior TRADING day: Friday for a Monday', () => {
    // 2026-11-09 is a Monday; its previous session is Friday 2026-11-06.
    const monday = '2026-11-09';
    const ok = planDate(
      monday,
      [row(1, '8:35 AM CT', {}, monday)],
      history(monday, { date: '2026-11-06', close: 7400 }),
    );
    expect(ok.skippedDate).toBeUndefined();

    const sunday = planDate(
      monday,
      [row(1, '8:35 AM CT', {}, monday)],
      history(monday, { date: '2026-11-08', close: 7400 }),
    );
    expect(sunday.skippedDate).toBe('no-previous-day');
  });
});

// ── planDate: the outcomes.settlement cross-check ───────────────────────────

describe('planDate: previous close against outcomes.settlement (G1b, 3.00)', () => {
  const rows = [row(1, '8:35 AM CT'), row(2, '9:00 AM CT')];
  const h = history(LIVE_DATE, PRIOR_OF_LIVE); // previous close 7560.87
  // A round close: 7003 - 7000 is exactly 3 in floating point, so 3.00 and 3.01
  // test the tolerance itself, and 7003.004 and 7003.006 test the rounding to
  // whole cents on either side of it (3.004 is 300 cents, 3.006 is 301).
  const round = history(LIVE_DATE, { date: '2026-11-04', close: 7000 });

  it.each([
    ['the same', 7000],
    ['0.05 above', 7000.05],
    ['0.05 below', 6999.95],
    ['2.55 above (an official close against a 5-minute close)', 7002.55],
    ['2.55 below', 6997.45],
    ['3.00 above', 7003],
    ['3.00 below', 6997],
    ['3.004 above (rounds to 300 cents)', 7003.004],
    ['3.004 below (rounds to 300 cents)', 6996.996],
  ])('plans the date when the settlement is %s: %f', (_name, settlement) => {
    const plan = planDate(LIVE_DATE, rows, round, settlement);

    expect(plan.skippedDate).toBeUndefined();
    expect(plan.previousClose).toBe(7000);
    expect(updates(plan.results)).toHaveLength(2);
  });

  it.each([
    ['3.01 above', 7003.01],
    ['3.01 below', 6996.99],
    ['3.006 above (rounds to 301 cents)', 7003.006],
    ['3.006 below (rounds to 301 cents)', 6996.994],
    ['10.00 above', 7010],
  ])(
    'skips the date as prev-close-mismatch when the settlement is %s: %f',
    (_name, settlement) => {
      const plan = planDate(LIVE_DATE, rows, round, settlement);

      expect(plan).toEqual({
        results: [],
        skippedDate: 'prev-close-mismatch',
        previousClose: 7000,
      });
    },
  );

  it('skips the wrong-week close the check exists for: 11-06 stored 7720.39 against the real 7356.73', () => {
    const plan = planDate(
      BACKTEST_DATE,
      [row(1, '8:35 AM CT', {}, BACKTEST_DATE)],
      history(BACKTEST_DATE, PRIOR_OF_BACKTEST),
      7720.39,
    );

    expect(plan).toEqual({
      results: [],
      skippedDate: 'prev-close-mismatch',
      previousClose: 7356.73,
    });
  });

  it('plans the 03-05 case: the official close 6869.50 against the 5-minute close 6868.95', () => {
    const plan = planDate(
      LIVE_DATE,
      rows,
      history(LIVE_DATE, { date: '2026-11-04', close: 6868.95 }),
      6869.5,
    );

    expect(plan.skippedDate).toBeUndefined();
    expect(plan.previousClose).toBe(6868.95);
  });

  it('plans the date, unchecked, when there is no settlement row', () => {
    const plan = planDate(LIVE_DATE, rows, h, null);

    expect(plan.skippedDate).toBeUndefined();
    expect(plan.previousClose).toBe(7560.87);
    expect(updates(plan.results)).toHaveLength(2);
  });

  it('reports no previous close for a date that never got that far', () => {
    expect(planDate(LIVE_DATE, rows, null, 7560.87).previousClose).toBe(
      undefined,
    );
    expect(
      planDate(LIVE_DATE, rows, history(LIVE_DATE, null), 7560.87)
        .previousClose,
    ).toBe(undefined);
  });
});

// ── planDate: values the columns can hold ───────────────────────────────────

describe('planDate: out-of-range values never reach the writer', () => {
  const rows = [row(1, '8:35 AM CT'), row(2, '9:00 AM CT')];

  it.each([0.5, 1e-320, 1e-7, 1e8, 1e25])(
    'skips the date as bad-previous-close for a previous close of %s',
    (close) => {
      // 7487 / 0.5 gives a gap of 1.5 million percent: DECIMAL(6,2) holds
      // under 10000. 1e-320 makes it infinite. 1e8 does not fit DECIMAL(10,2).
      const plan = planDate(
        LIVE_DATE,
        rows,
        history(LIVE_DATE, { date: '2026-11-04', close }),
      );

      expect(plan.skippedDate).toBe('bad-previous-close');
      expect(plan.results).toEqual([]);
    },
  );

  it('skips the date as bad-previous-close when the close rounds to 0.00, with no session open to test the gap against', () => {
    const h: DateHistory = {
      candles: session(LIVE_DATE, 78, (i, c) =>
        i === 0 ? { ...c, open: Number.NaN } : c,
      ),
      previousDay: { date: '2026-11-04', close: 1e-7 },
    };

    expect(planDate(LIVE_DATE, rows, h).skippedDate).toBe('bad-previous-close');
  });

  it('does not throw for a previous close the rounding cannot take', () => {
    expect(() =>
      planDate(
        LIVE_DATE,
        rows,
        history(LIVE_DATE, { date: '2026-11-04', close: 1e-320 }),
      ),
    ).not.toThrow();
  });

  it('lets the cross-check name a mismatch before it calls the close bad', () => {
    const plan = planDate(
      LIVE_DATE,
      rows,
      history(LIVE_DATE, { date: '2026-11-04', close: 0.5 }),
      7560.87,
    );

    expect(plan.skippedDate).toBe('prev-close-mismatch');
  });

  it('plans a close that gives the largest gap a column holds', () => {
    // The open is 7487; a close of 74.88 gives a gap of 9898.66%: it fits.
    const plan = planDate(
      LIVE_DATE,
      rows,
      history(LIVE_DATE, { date: '2026-11-04', close: 74.88 }),
    );

    expect(plan.skippedDate).toBeUndefined();
    expect(updates(plan.results)[0]?.after.overnight_gap).toBe('9898.66');
  });

  it.each([1e9, 1e25])(
    'marks the rows that include a bar with a high of %s bad-candles, and never throws',
    (high) => {
      // Bar 1 is 9:35 ET: the 8:40 CT slot is the first to include it.
      const h: DateHistory = {
        candles: session(LIVE_DATE, 78, (i, c) =>
          i === 1 ? { ...c, high } : c,
        ),
        previousDay: PRIOR_OF_LIVE,
      };

      const plan = planDate(
        LIVE_DATE,
        [row(1, '8:35 AM CT'), row(2, '8:40 AM CT')],
        h,
      );

      expect(plan.results.map((r) => [r.id, r.kind])).toEqual([
        [1, 'update'],
        [2, 'skip'],
      ]);
      expect(skips(plan.results)[0]?.reason).toBe('bad-candles');
    },
  );

  it('marks every filling row bad-candles when the session open is past DECIMAL(10,2)', () => {
    const h: DateHistory = {
      candles: session(LIVE_DATE, 78, (i, c) =>
        i === 0 ? { ...c, open: 1e9 } : c,
      ),
      previousDay: PRIOR_OF_LIVE,
    };

    const plan = planDate(LIVE_DATE, rows, h);

    // Not the whole date: the previous close is fine, the candle is not.
    expect(plan.skippedDate).toBeUndefined();
    expect(skips(plan.results).map((s) => s.reason)).toEqual([
      'bad-candles',
      'bad-candles',
    ]);
  });

  it('marks a row bad-candles when its stored open makes the gap overflow', () => {
    const odd = row(1, '9:00 AM CT', { spx_open: '99999999.99' });

    const plan = planDate(
      LIVE_DATE,
      [odd, row(2, '9:00 AM CT', { spx_open: '7487.00' })],
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    expect(skips(plan.results)).toEqual([
      { kind: 'skip', id: 1, reason: 'bad-candles' },
    ]);
    expect(updates(plan.results).map((u) => u.id)).toEqual([2]);
  });
});

// ── The feature-pick report ─────────────────────────────────────────────────

describe('featurePickChange', () => {
  // The range a replayed row stores: the day's high and low as of its slot on
  // the live date's candles (7505 and 7470 from 9:05 AM CT on).
  const RANGE = { spx_high: '7505.00', spx_low: '7470.00' };

  /** A row with its stored open, and the range when `ranged`. */
  const idle = (
    id: number,
    entryTime: string,
    open: string | null,
    ranged = true,
    over: Partial<SnapshotRowIn> = {},
  ) =>
    row(id, entryTime, { spx_open: open, ...(ranged ? RANGE : {}), ...over });

  const planOf = (rows: readonly SnapshotRowIn[]) =>
    planDate(LIVE_DATE, rows, history(LIVE_DATE, PRIOR_OF_LIVE)).results;

  it('reports the date whose chosen row changes once a later row gets its open', () => {
    // Before: only row 1 has an open, so it is the pick (row 2 has no range,
    // so it is not trusted yet). After: row 2, at 10:00 AM CT, has an open and
    // a range too and is nearest the sample time.
    const rows = [
      idle(1, '9:05 AM CT', '7487.00'),
      idle(2, '10:00 AM CT', null, false),
    ];

    expect(featurePickChange(rows, planOf(rows))).toEqual({ from: 1, to: 2 });
  });

  it('reports nothing when the pick does not move', () => {
    const rows = [idle(1, '9:05 AM CT', null), idle(2, '10:00 AM CT', null)];

    // Neither row has an open before: the pick is the one nearest 10:00 (2).
    // Both have one after: still 2.
    expect(featurePickChange(rows, planOf(rows))).toBeNull();
  });

  it('treats a stored NaN as no open, before the plan and after it', () => {
    const rows = [
      idle(1, '9:05 AM CT', 'NaN'),
      idle(2, '9:55 AM CT', '7487.00'),
    ];

    // Before: row 2 alone has an open. After: row 1 has one too, but row 2 is
    // still nearer 10:00.
    expect(featurePickChange(rows, planOf(rows))).toBeNull();
  });

  it('reads the rows in id order whatever order they come in', () => {
    const rows = [
      idle(2, '10:00 AM CT', null, false),
      idle(1, '9:05 AM CT', '7487.00'),
    ];

    expect(featurePickChange(rows, planOf(rows))).toEqual({ from: 1, to: 2 });
  });

  it('reports nothing for a date with no update', () => {
    const rows = [idle(1, '9:05 AM CT', null)];

    expect(featurePickChange(rows, [])).toBeNull();
  });

  it('reports a date whose plan makes its only row trusted', () => {
    // No range stored, so build-features rejects the row today (no-price-range)
    // and the date has no pick. The plan gives it an open and the range as of
    // its slot, with the stored spot inside it.
    const rows = [row(1, '10:00 AM CT')];
    const results = planOf(rows);

    expect(results[0]).toMatchObject({ kind: 'update', fill: 'all' });
    expect(featurePickChange(rows, results)).toEqual({ from: null, to: 1 });
  });

  it('judges the after pick on the planned range: a spot outside it stays untrusted', () => {
    // The plan's range from 10:00 AM CT is 7470 to 7505. SPX 7600 is more than
    // 10 points above it, so the row is still rejected after the plan.
    const rows = [row(1, '10:00 AM CT', { spx: '7600.00' })];

    expect(featurePickChange(rows, planOf(rows))).toBeNull();
  });

  it('keeps a row the plan cannot rescue untrusted: a stale tab and a late save', () => {
    const rows = [
      idle(1, '9:05 AM CT', '7487.00'),
      // Saved the next day at its slot's clock time.
      row(2, '10:00 AM CT', { saved_day_offset: 1, saved_minutes_ct: 600 }),
      // Saved 41 minutes after its slot.
      row(3, '9:55 AM CT', { saved_minutes_ct: 595 + 41 }),
    ];

    // Rows 2 and 3 get an open and a range, but their save times stay as they
    // were: row 1 is the pick before and after.
    expect(featurePickChange(rows, planOf(rows))).toBeNull();
  });

  it('is not moved by a pick that rests on nothing: no trusted row before or after', () => {
    const rows = [row(1, '8:35 AM CT'), row(2, '11:30 AM CT')];

    expect(featurePickChange(rows, planOf(rows))).toBeNull();
  });
});

// ── Reading a /api/history response ─────────────────────────────────────────

describe('readHistoryResponse', () => {
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      date: LIVE_DATE,
      spx: {
        candles: session(LIVE_DATE).map((c) => ({ ...c, time: '9:30 AM' })),
        previousClose: 7560.87,
        previousDay: { date: '2026-11-04', close: 7560.87, open: 7500 },
      },
      candleCount: 78,
      ...over,
    });

  it('returns the candles and the previous day for a good body', () => {
    const out = readHistoryResponse(LIVE_DATE, 200, body());

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.history.candles).toHaveLength(78);
    expect(out.history.candles[0]).toEqual({
      datetime: openMs(LIVE_DATE),
      open: 7487,
      high: 7495,
      low: 7480,
      close: 7490,
    });
    expect(out.history.previousDay).toEqual({
      date: '2026-11-04',
      close: 7560.87,
    });
  });

  it('fails the date for a 200 with no candles, naming both causes', () => {
    // The endpoint answers the same for a Schwab failure and for a date older
    // than Schwab's 5-minute window, so neither can be told apart here.
    const empty = JSON.stringify({
      date: LIVE_DATE,
      spx: { candles: [], previousClose: 0, previousDay: null },
    });

    expect(readHistoryResponse(LIVE_DATE, 200, empty)).toEqual({
      kind: 'failed',
      detail:
        "empty history: a Schwab failure, or a date older than Schwab's 5-minute window",
    });
  });

  it.each([
    [
      'two candles with the same datetime',
      (c: SlotCandle[]) => c.splice(5, 1, c[4] as SlotCandle),
    ],
    [
      'candles out of order',
      (c: SlotCandle[]) =>
        c.splice(4, 2, c[5] as SlotCandle, c[4] as SlotCandle),
    ],
    [
      'a candle with no datetime',
      (c: SlotCandle[]) =>
        c.splice(5, 1, { ...(c[5] as SlotCandle), datetime: Number.NaN }),
    ],
  ])(
    'fails the date for %s: a server dedupe regression must not become a wrong high',
    (_name, damage) => {
      const candles = session(LIVE_DATE);
      damage(candles);

      const out = readHistoryResponse(
        LIVE_DATE,
        200,
        body({ spx: { candles, previousDay: null } }),
      );

      expect(out.kind).toBe('failed');
      if (out.kind !== 'failed') return;
      expect(out.detail).toMatch(/strictly ascending/);
      expect(out.detail).toMatch(/candle [45]\b/);
    },
  );

  it('keeps a null previous day as null', () => {
    const out = readHistoryResponse(
      LIVE_DATE,
      200,
      body({
        spx: {
          candles: session(LIVE_DATE),
          previousClose: 0,
          previousDay: null,
        },
      }),
    );

    expect(out).toMatchObject({ kind: 'ok', history: { previousDay: null } });
  });

  it('turns a non-number candle field into NaN, so it surfaces as bad-candles', () => {
    const candles = session(LIVE_DATE).map((c, i) =>
      i === 4 ? { ...c, high: null, low: '7470' } : c,
    );

    const out = readHistoryResponse(
      LIVE_DATE,
      200,
      body({ spx: { candles, previousDay: null } }),
    );

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.history.candles[4]?.high).toBeNaN();
    expect(out.history.candles[4]?.low).toBeNaN();
    expect(out.history.candles[3]?.high).toBe(FLAT.high);
  });

  it('turns a malformed previous day into one that never matches', () => {
    const out = readHistoryResponse(
      LIVE_DATE,
      200,
      body({
        spx: {
          candles: session(LIVE_DATE),
          previousDay: { date: 20261104, close: '7560.87' },
        },
      }),
    );

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(
      planDate(LIVE_DATE, [row(1, '8:35 AM CT')], out.history).skippedDate,
    ).toBe('no-previous-day');
  });

  it.each([
    ['a 500', 500, '{"error":"Internal server error"}', /HTTP 500/],
    ['a 429', 429, '', /HTTP 429/],
    ['a 200 that is not JSON', 200, '<html>Bad gateway</html>', /not JSON/],
    ['an empty 200', 200, '', /not JSON/],
    ['a 200 holding an array', 200, '[]', /no spx/],
    ['a 200 without spx', 200, JSON.stringify({ date: LIVE_DATE }), /no spx/],
    [
      'a 200 whose spx is null',
      200,
      JSON.stringify({ date: LIVE_DATE, spx: null }),
      /no spx/,
    ],
    [
      'a 200 whose candles are not an array',
      200,
      JSON.stringify({ date: LIVE_DATE, spx: { candles: 'x' } }),
      /candles/,
    ],
    [
      'a 200 whose candle is not an object',
      200,
      JSON.stringify({ date: LIVE_DATE, spx: { candles: [1, 2] } }),
      /candle/,
    ],
    [
      'a 200 echoing another date',
      200,
      JSON.stringify({ date: '2026-11-04', spx: { candles: [] } }),
      /2026-11-04/,
    ],
  ])('names the failure for %s', (_name, status, text, detail) => {
    const out = readHistoryResponse(LIVE_DATE, status, text);

    expect(out.kind).toBe('failed');
    if (out.kind !== 'failed') return;
    expect(out.detail).toMatch(detail);
  });

  it.each([401, 403])(
    'says denied for a %i, not a per-date failure',
    (code) => {
      expect(readHistoryResponse(LIVE_DATE, code, '{}')).toEqual({
        kind: 'denied',
        status: code,
      });
    },
  );

  describe('a Schwab failure that /api/history names', () => {
    const body = (code: unknown) =>
      JSON.stringify({ error: 'Schwab is logged out.', code });

    it('says logged-out for a 503 with code schwab_logged_out: every later date would fail the same way', () => {
      expect(
        readHistoryResponse(LIVE_DATE, 503, body('schwab_logged_out')),
      ).toEqual({ kind: 'logged-out', status: 503 });
    });

    it.each([
      ['a 503 with another code', 503, body('schwab_fetch_failed')],
      ['a 503 with no code', 503, '{"error":"Service Unavailable"}'],
      ['a 503 that is not JSON', 503, '<html>503</html>'],
      ['a 503 whose code is not a string', 503, body(['schwab_logged_out'])],
      ['a 502 with the logged-out code', 502, body('schwab_logged_out')],
      ['a 200 with the logged-out code', 200, body('schwab_logged_out')],
    ])('is not logged-out for %s', (_name, status, text) => {
      expect(readHistoryResponse(LIVE_DATE, status, text).kind).not.toBe(
        'logged-out',
      );
    });

    it('keeps a 502 a per-date failure, with the code in the detail', () => {
      expect(
        readHistoryResponse(LIVE_DATE, 502, body('schwab_fetch_failed')),
      ).toEqual({ kind: 'failed', detail: 'HTTP 502 (schwab_fetch_failed)' });
    });

    it('names a 503 with another code the same way', () => {
      expect(
        readHistoryResponse(LIVE_DATE, 503, body('some_other_code')),
      ).toEqual({ kind: 'failed', detail: 'HTTP 503 (some_other_code)' });
    });

    it.each([
      ['no code', '{"error":"boom"}'],
      ['a code that is not a string', body(42)],
      ['a code with spaces and markup', body('<b>bad code</b>')],
      ['a code of a hundred characters', body('a'.repeat(100))],
      ['an empty code', body('')],
      ['a body that is not JSON', 'upstream <html>'],
      ['an empty body', ''],
      // The edges of /^[a-z][a-z0-9_]{0,39}$/: 41 characters, a trailing
      // newline ($ is the end of the string, not of a line), an uppercase
      // letter, a leading digit or underscore, an escape character.
      ['a code of 41 characters', body('a'.repeat(41))],
      ['a code with a trailing newline', body('schwab_fetch_failed\n')],
      ['a code with an uppercase letter', body('schwab_Fetch_failed')],
      ['a code that starts with a digit', body('4xx_failed')],
      ['a code that starts with an underscore', body('_fetch_failed')],
      ['a code with an escape character', body('schwab\u001b[31m_failed')],
      ['a code with a hyphen', body('schwab-fetch-failed')],
    ])('leaves a 502 with %s as plain HTTP 502', (_name, text) => {
      // The body is the response of a host we do not control end to end: only
      // a short snake-case token is copied into the report.
      expect(readHistoryResponse(LIVE_DATE, 502, text)).toEqual({
        kind: 'failed',
        detail: 'HTTP 502',
      });
    });

    it.each([
      ['one letter', 'a'],
      ['40 characters, the longest', 'a'.repeat(40)],
      ['letters, digits and underscores', 'http_502_fetch_failed_2'],
      ['a trailing underscore', 'schwab_'],
    ])('copies a code of %s into the detail', (_name, code) => {
      expect(readHistoryResponse(LIVE_DATE, 502, body(code))).toEqual({
        kind: 'failed',
        detail: `HTTP 502 (${code})`,
      });
    });
  });
});

// ── Arguments ───────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to a dry run over every date', () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      since: null,
      until: null,
      undoFile: null,
      planFile: null,
      envFile: null,
      help: false,
    });
  });

  it('reads a dry run with a range', () => {
    expect(
      parseArgs(['--since', '2026-05-01', '--until', '2026-11-05']),
    ).toMatchObject({ apply: false, since: '2026-05-01', until: '2026-11-05' });
  });

  it('reads --apply with --plan and --env-file', () => {
    expect(
      parseArgs([
        '--apply',
        '--plan',
        'docs/tmp/p.json',
        '--env-file',
        'x/.env.local',
      ]),
    ).toEqual({
      apply: true,
      since: null,
      until: null,
      undoFile: null,
      planFile: 'docs/tmp/p.json',
      envFile: 'x/.env.local',
      help: false,
    });
  });

  it('reads --plan alone, which only counts the plan', () => {
    expect(parseArgs(['--plan', 'p.json'])).toMatchObject({
      apply: false,
      planFile: 'p.json',
    });
  });

  it('reads --undo-file, --dry-run said aloud, and --help', () => {
    expect(parseArgs(['--undo-file', 'u.json', '--apply']).undoFile).toBe(
      'u.json',
    );
    expect(parseArgs(['--dry-run']).apply).toBe(false);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it.each([
    [['--apply', '--dry-run'], /--apply and --dry-run contradict/],
    [['--apply'], /--apply needs --plan <dry-run file> or --undo-file <file>/],
    [
      ['--apply', '--since', '2026-05-01'],
      /--apply needs --plan <dry-run file> or --undo-file <file>/,
    ],
    [['--since'], /--since needs a value/],
    [['--since', '--apply'], /--since needs a value/],
    [['--until'], /--until needs a value/],
    [['--env-file'], /--env-file needs a value/],
    [['--undo-file'], /--undo-file needs a value/],
    [['--plan'], /--plan needs a value/],
    [['--plan', '--apply'], /--plan needs a value/],
    [['--since', '2026-02-30'], /--since 2026-02-30 is not a YYYY-MM-DD date/],
    [['--until', 'yesterday'], /--until yesterday is not a YYYY-MM-DD date/],
    [
      ['--since', '2026-11-05', '--until', '2026-11-04'],
      /--since 2026-11-05 is after --until 2026-11-04/,
    ],
    [
      ['--undo-file', 'u.json', '--since', '2026-11-05'],
      /--undo-file contradicts --since and --until/,
    ],
    [
      ['--undo-file', 'u.json', '--until', '2026-11-05'],
      /--undo-file contradicts --since and --until/,
    ],
    [
      ['--plan', 'p.json', '--since', '2026-11-05'],
      /--plan contradicts --since and --until/,
    ],
    [
      ['--plan', 'p.json', '--until', '2026-11-05', '--apply'],
      /--plan contradicts --since and --until/,
    ],
    [
      ['--plan', 'p.json', '--undo-file', 'u.json', '--apply'],
      /--plan and --undo-file contradict/,
    ],
    [
      ['--until', '2026-11-19'],
      /--until 2026-11-19 is after 2026-11-18, the last date this script covers: from the next day a live row carries the quote's real-time open, high and low/,
    ],
    [
      ['--since', '2026-11-19', '--until', '2026-11-20'],
      /--since 2026-11-19 is after 2026-11-18/,
    ],
    [['--since', '2026-12-01'], /--since 2026-12-01 is after 2026-11-18/],
    [['--bogus'], /unknown argument --bogus/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('takes the last replay date itself as --until, and the day before as --since', () => {
    expect(parseArgs(['--until', '2026-11-18']).until).toBe('2026-11-18');
    expect(parseArgs(['--since', '2026-11-18']).since).toBe('2026-11-18');
    expect(
      parseArgs(['--since', '2026-11-17', '--until', '2026-11-18']),
    ).toMatchObject({ since: '2026-11-17', until: '2026-11-18' });
  });
});

// ── The dry-run report ──────────────────────────────────────────────────────

function datePlan(
  date: string,
  rows: SnapshotRowIn[],
  fetch: DatePlan['fetch'],
  hist: DateHistory | null,
  fetchDetail: string | null = null,
  settlement: number | null = null,
): DatePlan {
  const { results, skippedDate, previousClose } = planDate(
    date,
    rows,
    hist,
    settlement,
  );
  return {
    date,
    rows,
    fetch,
    fetchDetail,
    results,
    skippedDate: skippedDate ?? null,
    pickChange: featurePickChange(rows, results),
    previousClose: previousClose ?? null,
    settlement,
  };
}

const PLAN_FILE = 'docs/tmp/snapshot-price-context/dry-run-x.json';
const EMPTY_DETAIL =
  "empty history: a Schwab failure, or a date older than Schwab's 5-minute window";

function dryRunOf(
  dates: DatePlan[],
  over: Partial<DryRunResult> = {},
): DryRunResult {
  return {
    since: null,
    until: '2026-11-17',
    dates,
    untried: [],
    planFile: PLAN_FILE,
    ...over,
  };
}

const lastLine = (text: string): string =>
  text.trimEnd().split('\n').at(-1) ?? '';

describe('formatReport', () => {
  const liveRows = [
    row(1, '8:35 AM CT'),
    row(2, '9:10 AM CT'),
    row(3, 'pre-market', { prev_close: '7720.39' }),
    row(4, '8:00 AM CT'),
    row(5, '10:00 AM CT', {
      spx_open: '7487.00',
      prev_close: '7560.87',
      overnight_gap: '-0.98',
    }),
  ];
  const badBar: DateHistory = {
    candles: session(LIVE_DATE, 78, (i, c) =>
      i === 6 ? { ...c, high: Number.NaN } : c,
    ),
    previousDay: PRIOR_OF_LIVE,
  };
  const backtestRows = [
    row(
      10,
      '9:00 AM CT',
      {
        spx_open: '7377.65',
        spx_high: '7390.10',
        spx_low: '7370.20',
        prev_close: '7720.39',
        overnight_gap: '-4.44',
      },
      BACKTEST_DATE,
    ),
    row(
      11,
      '10:00 AM CT',
      { spx_open: '7377.65', prev_close: '7720.39' },
      BACKTEST_DATE,
    ),
  ];

  const dates = [
    datePlan(
      '2026-10-29',
      [row(50, '9:00 AM CT', {}, '2026-10-29')],
      'ok',
      history('2026-10-29', { date: '2026-10-28', close: 7000 }),
      null,
      7100,
    ),
    datePlan(
      '2026-10-30',
      [row(40, '9:00 AM CT', { prev_close: '7001.00' }, '2026-10-30')],
      'ok',
      history('2026-10-30', PRIOR_OF_LIVE, 60),
    ),
    datePlan(
      '2026-11-02',
      [row(20, '9:00 AM CT', { overnight_gap: '-1.00' }, '2026-11-02')],
      'failed',
      null,
      EMPTY_DETAIL,
    ),
    datePlan(
      '2026-11-03',
      [row(30, '9:00 AM CT', {}, '2026-11-03')],
      'failed',
      null,
      'HTTP 500',
    ),
    datePlan(LIVE_DATE, liveRows, 'ok', badBar, null, 7560.87),
    datePlan(
      BACKTEST_DATE,
      backtestRows,
      'ok',
      history(BACKTEST_DATE, PRIOR_OF_BACKTEST),
    ),
  ];

  it('counts rows and dates, and says it is a dry run that writes nothing', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toContain('DRY RUN (writes nothing to the database)');
    expect(text).toContain('Read: 11 rows on 6 dates');
  });

  it('groups the failed fetches by cause, naming the empty-history message', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toMatch(/history fetch failed:\s+2 dates \(2 rows\)/);
    expect(text).toContain(`${EMPTY_DETAIL} (1 date): 2026-11-02`);
    expect(text).toContain('HTTP 500 (1 date): 2026-11-03');
    expect(text).not.toMatch(/no data from the history endpoint/);
  });

  it('lists a previous-close mismatch with both values and the difference', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toMatch(/prev-close-mismatch:\s+1 date \(1 row\)/);
    expect(text).toContain(
      '2026-10-29: previous close 7000.00, settlement 7100.00, difference 100.00',
    );
  });

  it('says what the settlement cross-check proves, and lists the dates it did not cover', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toContain(
      'Previous close within 3.00 of outcomes.settlement: 1 date',
    );
    expect(text).not.toContain('within 0.05');
    expect(text).toContain(
      "a settlement from the end-of-day run is the last 5-minute bar's close, the same feed as the previous close",
    );
    expect(text).toContain(
      'one from a fetch-outcomes backfill is the official close, which can differ from the 5-minute close by a point or two',
    );
    expect(text).not.toContain('not an official-close check');
    expect(text).toMatch(
      /Previous close not cross-checked \(no outcomes.settlement for the prior trading day\), planned anyway: 1 date: 2026-11-06/,
    );
  });

  describe('the planned dates whose previous close is more than 0.05 from the settlement', () => {
    const LIST_HEAD =
      "Previous close more than 0.05 from outcomes.settlement, planned (the prior day's settlement is likely the official close from a fetch-outcomes backfill):";

    /** A planned date: its history's previous close is 7000, or `close`. */
    const planned = (
      date: string,
      prior: string,
      settlement: number | null,
      close = 7000,
    ): DatePlan =>
      datePlan(
        date,
        [row(1, '9:00 AM CT', {}, date)],
        'ok',
        history(date, { date: prior, close }),
        null,
        settlement,
      );

    const listLine = (text: string): string =>
      text.split('\n').find((l) => l.startsWith(LIST_HEAD)) ?? '';

    it('prints "0 dates" when every planned date matches to 0.05 or better', () => {
      const text = formatReport(dryRunOf(dates));

      expect(listLine(text)).toBe(`${LIST_HEAD} 0 dates`);
    });

    it('lists each planned date more than 0.05 away with its difference to the cent, and no other', () => {
      const text = formatReport(
        dryRunOf([
          planned('2026-11-02', '2026-10-30', 7000.55),
          // 0.03 away: close enough that nobody needs to look.
          planned('2026-11-03', '2026-11-02', 7000.03),
          // Exactly 0.05 away. 7000.05 - 7000 is 0.05000000000018 in floating
          // point, so only a whole-cent comparison keeps it off the list.
          planned('2026-11-04', '2026-11-03', 7000.05),
          planned('2026-11-05', '2026-11-04', 7000.06),
          // The settlement below the previous close: 7356.73 - 7354.18.
          planned('2026-11-06', '2026-11-05', 7354.18, 7356.73),
          // Skipped as prev-close-mismatch (100.00 away): it is not planned.
          planned('2026-11-09', '2026-11-06', 7100),
          // No settlement row: not cross-checked, so nothing to compare.
          planned('2026-11-10', '2026-11-09', null),
          // Exactly the same.
          planned('2026-11-11', '2026-11-10', 7000),
          // 0.50 from its settlement, so within 3.00 and more than 0.05 off,
          // but a close of 0.5 gives a gap no column holds: skipped whole as
          // bad-previous-close, so not planned and not on the list.
          planned('2026-11-12', '2026-11-11', 1, 0.5),
        ]),
      );

      expect(listLine(text)).toBe(
        `${LIST_HEAD} 3 dates: 2026-11-02 (0.55), 2026-11-05 (0.06), 2026-11-06 (2.55)`,
      );
      expect(text).toContain(
        'Previous close within 3.00 of outcomes.settlement: 6 dates',
      );
      expect(text).toMatch(/bad-previous-close:\s+1 date \(1 row\)/);
      expect(text).toContain('2026-11-12: previous close 0.5');
      expect(listLine(text)).not.toContain('2026-11-12');
    });

    it('caps the list at 30 dates and says how many more', () => {
      const many = Array.from({ length: 32 }, (_, i): DatePlan => {
        const date = `2026-03-${String(i + 1).padStart(2, '0')}`;
        return {
          date,
          rows: [],
          fetch: 'ok',
          fetchDetail: null,
          results: [],
          skippedDate: null,
          pickChange: null,
          previousClose: 7000,
          settlement: 7001,
        };
      });

      const line = listLine(formatReport(dryRunOf(many)));

      expect(line).toContain(`${LIST_HEAD} 32 dates: 2026-03-01 (1.00)`);
      expect(line).toContain('2026-03-30 (1.00), and 2 more');
      expect(line).not.toContain('2026-03-31');
    });
  });

  it('says why each other date was skipped whole', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toMatch(/short-candles:\s+1 date \(1 row\)/);
    expect(text).toContain('2026-10-30');
    expect(text).toMatch(/no-previous-day:\s+0 dates \(0 rows\)/);
    expect(text).toMatch(/bad-previous-close:\s+0 dates \(0 rows\)/);
    expect(text).toMatch(/not-a-trading-day:\s+0 dates \(0 rows\)/);
  });

  it('lists a date that is not a trading day, and does not count it as a failure', () => {
    const saturday = datePlan(
      '2026-11-07',
      [
        row(1, '9:00 AM CT', {}, '2026-11-07'),
        row(2, '9:30 AM CT', {}, '2026-11-07'),
      ],
      'not-fetched',
      null,
    );
    const result = dryRunOf([saturday]);

    const text = formatReport(result);

    expect(text).toMatch(/not-a-trading-day:\s+1 date \(2 rows\)/);
    expect(text).toContain('2026-11-07');
    expect(text).not.toMatch(/history fetch failed:\s+[1-9]/);
    expect(text).not.toContain('WARNING: 1 date not planned');
    expect(lastLine(text)).toBe(
      'Planned 0 updates. Not planned: 1 date with 2 rows (not-a-trading-day 1).',
    );
    expect(exitCodeOfDryRun(result)).toBe(0);
  });

  it('names a bad-previous-close date with the close and the gap it gives', () => {
    const bad = datePlan(
      LIVE_DATE,
      [row(1, '8:35 AM CT')],
      'ok',
      history(LIVE_DATE, { date: '2026-11-04', close: 0.5 }),
    );

    const text = formatReport(dryRunOf([bad]));

    expect(text).toMatch(/bad-previous-close:\s+1 date \(1 row\)/);
    expect(text).toContain(`${LIVE_DATE}: previous close 0.5`);
  });

  it('counts every kind of row apart, with "already right" apart from the rows left alone', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toContain('Planned updates: 3');
    expect(text).toMatch(/fill all five columns:\s+1\b/);
    expect(text).toMatch(
      /replayed rows: high, low, previous close, gap:\s+2\b/,
    );
    expect(text).toMatch(/previous close and gap only \(bad candles\):\s+0\b/);
    expect(text).toMatch(/no-slot:\s+1\b/);
    expect(text).toMatch(/before-open:\s+1\b/);
    expect(text).toMatch(/bad-candles:\s+1\b/);
    expect(text).toMatch(/open-mismatch:\s+0\b/);
    // The one unchanged row here sits on a bad bar: its previous close and gap
    // are right, but nothing says its high and low are, so it is not "right".
    expect(text).toContain(
      'Rows already right (they hold their planned values): 0',
    );
    expect(text).toContain(
      'Rows with only the previous close and gap right, high/low left as stored (bad candles): 1',
    );
    // One word for it everywhere: not "unchanged".
    expect(text).not.toMatch(/\bunchanged\b/);
  });

  it('counts the replayed rows whose high or low narrowed, a fill not being one', () => {
    const text = formatReport(dryRunOf(dates));

    // Row 10 loses its peek on both sides; row 11 had no high or low to narrow.
    expect(text).toContain(
      'Replayed rows whose high or low narrowed: 1 (high 1, low 1)',
    );
  });

  it('names the rows with an open whose high and low were left as stored, bad candles', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toContain(
      'WARNING: 1 row with an open: high/low left as stored (bad candles); only the previous close and gap are planned. By date, the row ids:',
    );
    expect(text).toContain(`${LIVE_DATE}: 5`);
  });

  it('counts a narrower update and an unchanged row alike in that warning', () => {
    const stored = {
      spx_open: '7377.65',
      spx_high: '7390.10',
      spx_low: '7370.20',
    };
    const broken: DateHistory = {
      candles: session(BACKTEST_DATE, 78, (i, c) =>
        i === 6 ? { ...c, high: Number.NaN } : c,
      ),
      previousDay: PRIOR_OF_BACKTEST,
    };
    const day = datePlan(
      BACKTEST_DATE,
      [
        row(
          1,
          '9:10 AM CT',
          { ...stored, prev_close: '7720.39' },
          BACKTEST_DATE,
        ),
        row(
          2,
          '9:15 AM CT',
          { ...stored, prev_close: '7356.73', overnight_gap: '0.28' },
          BACKTEST_DATE,
        ),
      ],
      'ok',
      broken,
    );

    const text = formatReport(dryRunOf([day]));

    expect(text).toContain(
      'WARNING: 2 rows with an open: high/low left as stored',
    );
    expect(text).toContain(`${BACKTEST_DATE}: 1, 2`);
    expect(text).toMatch(/previous close and gap only \(bad candles\):\s+1\b/);
  });

  it('lists an open-mismatch row with both opens, and counts it among the rows left alone', () => {
    const odd = datePlan(
      BACKTEST_DATE,
      [row(11, '9:00 AM CT', { spx_open: '7400.00' }, BACKTEST_DATE)],
      'ok',
      history(BACKTEST_DATE, PRIOR_OF_BACKTEST),
    );

    const text = formatReport(dryRunOf([odd]));

    expect(text).toMatch(/open-mismatch:\s+1\b/);
    expect(text).toContain(
      'WARNING: 1 row with an open skipped as open-mismatch',
    );
    expect(text).toContain(
      `${BACKTEST_DATE}: 11 (stored 7400.00, as of the slot 7377.65)`,
    );
    expect(lastLine(text)).toBe(
      'Planned 0 updates. Not planned: 0 dates with 0 rows; 1 row left alone (open-mismatch 1).',
    );
  });

  it('lists the open-mismatch rows of every date, each date capped on its own', () => {
    const odd = (id: number, entry: string, date: string) =>
      row(id, entry, { spx_open: '7400.00' }, date);
    // One date has more mismatched rows than the cap: a single list, capped
    // overall, would have hidden the second date altogether.
    const many = Array.from({ length: 35 }, (_, i) =>
      odd(100 + i, '9:00 AM CT', BACKTEST_DATE),
    );
    const few = [
      odd(200, '8:35 AM CT', LIVE_DATE),
      odd(201, '8:40 AM CT', LIVE_DATE),
    ];
    const text = formatReport(
      dryRunOf([
        datePlan(LIVE_DATE, few, 'ok', history(LIVE_DATE, PRIOR_OF_LIVE)),
        datePlan(
          BACKTEST_DATE,
          many,
          'ok',
          history(BACKTEST_DATE, PRIOR_OF_BACKTEST),
        ),
      ]),
    );

    const lines = text.split('\n');
    const head = lines.findIndex((l) => l.includes('skipped as open-mismatch'));
    expect(lines[head]).toContain('WARNING: 37 rows with an open');
    const [first, second] = [lines[head + 1] ?? '', lines[head + 2] ?? ''];
    expect(first).toBe(
      `  ${LIVE_DATE}: 200 (stored 7400.00, as of the slot 7487.00), 201 (stored 7400.00, as of the slot 7487.00)`,
    );
    expect(second.startsWith(`  ${BACKTEST_DATE}: 100 (stored 7400.00, `)).toBe(
      true,
    );
    // 30 shown, and the other 5 counted, on that date alone.
    expect(second).toContain('129 (stored 7400.00');
    expect(second).not.toContain('130 (stored');
    expect(second.endsWith(', and 5 more')).toBe(true);
    // Two dates, two lines: nothing else is listed under the warning.
    expect(lines[head + 3]).not.toMatch(/^ {2}\d{4}-\d{2}-\d{2}: /);
  });

  describe('a replayed row whose high or low widened', () => {
    // The replay read every bar the as-of high and low use, so a stored high
    // below the as-of high (7388.00 here) or a stored low above the as-of low
    // (7372.00) means the candles changed after it. The as-of values are
    // still written: today's candles are the source.
    const replayed = (id: number, over: Partial<SnapshotRowIn>) =>
      row(
        id,
        '9:00 AM CT',
        {
          spx_open: '7377.65',
          prev_close: '7720.39',
          overnight_gap: '-4.44',
          ...over,
        },
        BACKTEST_DATE,
      );
    const reportOf = (rows: SnapshotRowIn[]) =>
      formatReport(
        dryRunOf([
          datePlan(
            BACKTEST_DATE,
            rows,
            'ok',
            history(BACKTEST_DATE, PRIOR_OF_BACKTEST),
          ),
        ]),
      );
    const rows = [
      // Both sides inside the as-of range: widened, high and low.
      replayed(21, { spx_high: '7380.00', spx_low: '7374.00' }),
      // The high is exactly the as-of high: only the low widened.
      replayed(22, { spx_high: '7388.00', spx_low: '7374.00' }),
      // A fill: no high or low to widen or to narrow.
      replayed(23, {}),
      // The peek: both sides narrowed.
      replayed(24, { spx_high: '7390.10', spx_low: '7370.20' }),
      // The high widened and the low narrowed: counted on each side.
      replayed(25, { spx_high: '7380.00', spx_low: '7370.20' }),
    ];

    it('counts them by side, a fill and an equal value being neither, and a row on both sides of the comparison', () => {
      const text = reportOf(rows);

      expect(text).toContain(
        'Replayed rows whose high or low widened: 3 (high 2, low 2)',
      );
      expect(text).toContain(
        'Replayed rows whose high or low narrowed: 2 (high 1, low 2)',
      );
    });

    it('lists them by date and id in a warning, and still plans their as-of values', () => {
      const text = reportOf(rows);

      expect(text).toContain(
        "WARNING: 3 replayed rows hold a high below, or a low above, the value as of their slot, though the replay read every bar that value uses: the candles changed since. They are written all the same, from today's candles. By date, the row ids:",
      );
      expect(text).toContain(`${BACKTEST_DATE}: 21, 22, 25`);
      expect(text).toContain('Planned updates: 5');
    });

    it('agrees with one row: holds, its slot, it is written', () => {
      const text = reportOf([
        replayed(21, { spx_high: '7380.00', spx_low: '7374.00' }),
      ]);

      expect(text).toContain(
        "WARNING: 1 replayed row holds a high below, or a low above, the value as of its slot, though the replay read every bar that value uses: the candles changed since. It is written all the same, from today's candles. By date, the row ids:",
      );
      expect(text).toContain(`${BACKTEST_DATE}: 21`);
    });

    it('says none, and warns of none, when no row widened', () => {
      const text = formatReport(dryRunOf(dates));

      expect(text).toContain(
        'Replayed rows whose high or low widened: 0 (high 0, low 0)',
      );
      expect(text).not.toContain('hold a high below, or a low above');
    });

    it('compares at 2 decimals: a stored value equal to the as-of one is neither', () => {
      const text = reportOf([
        replayed(26, { spx_high: '7388.00', spx_low: '7372.00' }),
      ]);

      expect(text).toContain(
        'Replayed rows whose high or low widened: 0 (high 0, low 0)',
      );
      expect(text).toContain(
        'Replayed rows whose high or low narrowed: 0 (high 0, low 0)',
      );
    });
  });

  it('shows a replayed row among the samples', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toContain(
      'id 10 2026-11-06 9:00 AM CT: spx_high 7390.10 -> 7388.00, spx_low 7370.20 -> 7372.00, prev_close 7720.39 -> 7356.73, overnight_gap -4.44 -> 0.28',
    );
  });

  it('lists the bad-candles rows by date and id, loudly', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toMatch(/WARNING: 1 row skipped as bad-candles/);
    expect(text).toContain(`${LIVE_DATE}: 2`);
  });

  it('counts fills apart from overwrites, per written column, with the largest change', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toMatch(/spx_open\s+fill 1, overwrite 0$/m);
    // A replayed row's high and low are overwrites, bucketed like prices.
    expect(text).toMatch(
      /spx_high\s+fill 2, overwrite 1 \(same 0, <=0\.05 0, <=1 0, >1 1\), largest change 2\.10 \(id 10, 2026-11-06\)/,
    );
    expect(text).toMatch(
      /spx_low\s+fill 2, overwrite 1 \(same 0, <=0\.05 0, <=1 0, >1 1\), largest change 1\.80 \(id 10, 2026-11-06\)/,
    );
    expect(text).toMatch(
      /prev_close\s+fill 1, overwrite 2 \(same 0, <=0\.05 0, <=1 0, >1 2\), largest change 363\.66 \(id 10, 2026-11-06\)/,
    );
    // The gap is in percentage points, with its own buckets.
    expect(text).toMatch(
      /overnight_gap\s+fill 2, overwrite 1 \(same 0, <=0\.01 0, <=0\.1 0, >0\.1 1\), largest change 4\.72 pp \(id 10, 2026-11-06\)/,
    );
    expect(text).toContain('overnight_gap changes are in percentage points');
  });

  it('buckets the overwrites by size, prices apart from the gap, and counts a stored NaN as a fill', () => {
    const own = { spx_open: '7487.00' };
    const rows = [
      row(1, '8:35 AM CT', { spx_open: 'NaN' }),
      row(2, '9:00 AM CT', { ...own, prev_close: '7560.84' }),
      row(3, '9:05 AM CT', {
        ...own,
        prev_close: '7560.00',
        overnight_gap: '-0.98',
      }),
      row(4, '9:10 AM CT', {
        ...own,
        prev_close: '7560.87',
        overnight_gap: '-0.50',
      }),
      row(5, '9:15 AM CT', {
        ...own,
        prev_close: '7560.87',
        overnight_gap: '-0.97',
      }),
      row(6, '9:20 AM CT', {
        ...own,
        prev_close: '7560.87',
        overnight_gap: '-0.90',
      }),
    ];
    const one = datePlan(
      LIVE_DATE,
      rows,
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    const text = formatReport(dryRunOf([one]));

    expect(text).toMatch(
      /prev_close\s+fill 1, overwrite 5 \(same 3, <=0\.05 1, <=1 1, >1 0\), largest change 0\.87 \(id 3, 2026-11-05\)/,
    );
    expect(text).toMatch(
      /overnight_gap\s+fill 2, overwrite 4 \(same 1, <=0\.01 1, <=0\.1 1, >0\.1 1\), largest change 0\.48 pp \(id 4, 2026-11-05\)/,
    );
    expect(text).toMatch(/spx_open\s+fill 1, overwrite 0$/m);
  });

  it('counts the stale values left on rows apart: rows left alone, and rows on skipped dates', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toContain(
      'Rows left alone that hold a prev_close or gap: 1 (no-slot 1)',
    );
    expect(text).toContain(
      'Rows on skipped dates that hold a prev_close or gap: 2 (history fetch failed 1, short-candles 1)',
    );
  });

  it('does not count a stored NaN as holding a value', () => {
    const nan = datePlan(
      LIVE_DATE,
      [row(1, 'pre-market', { prev_close: 'NaN', overnight_gap: 'NaN' })],
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );
    const failed = datePlan(
      BACKTEST_DATE,
      [row(2, '9:00 AM CT', { prev_close: 'NaN' }, BACKTEST_DATE)],
      'failed',
      null,
      'HTTP 500',
    );

    const text = formatReport(dryRunOf([nan, failed]));

    expect(text).toContain('Rows left alone that hold a prev_close or gap: 0');
    expect(text).toContain(
      'Rows on skipped dates that hold a prev_close or gap: 0',
    );
  });

  it('lists the entry labels it could not read, with counts', () => {
    const odd = datePlan(
      LIVE_DATE,
      [
        row(1, 'pre-market'),
        row(2, 'pre-market'),
        row(3, 'Pre-Market'),
        row(4, 'noon'),
      ],
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    const text = formatReport(dryRunOf([odd]));

    expect(text).toContain(
      'Entry labels skipped as no-slot: "pre-market" x 2, "Pre-Market" x 1, "noon" x 1',
    );
  });

  it('shows two samples per kind for the hand check', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toContain('id 1 ');
    expect(text).toContain('id 10 ');
    expect(text).toContain('NULL -> 7487.00');
  });

  it('names the dates whose feature pick changes', () => {
    // Row 1 is trusted today (open and range stored); row 2, nearer 10:00 AM
    // CT, has no range, so it is rejected until the plan fills one.
    const changing = datePlan(
      LIVE_DATE,
      [
        row(1, '9:05 AM CT', {
          spx_open: '7487.00',
          spx_high: '7505.00',
          spx_low: '7470.00',
        }),
        row(2, '10:00 AM CT'),
      ],
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    const text = formatReport(dryRunOf([changing]));

    expect(text).toContain(`${LIVE_DATE}: row 1 -> row 2`);
  });

  it('names a date that has no pick today and gets one from the plan', () => {
    const gained = datePlan(
      LIVE_DATE,
      [row(1, '10:00 AM CT')],
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    const text = formatReport(dryRunOf([gained]));

    expect(text).toContain(`${LIVE_DATE}: none -> row 1`);
  });

  it('prints the reconciliation of the rows read, and the plan file with the apply command', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toContain(
      'Reconciliation: 11 rows read = 3 planned + 0 already right + 1 right in previous close and gap only + 3 left alone + 4 on skipped dates',
    );
    expect(text).toContain(`Plan file: ${PLAN_FILE}`);
    expect(text).toContain(
      `npx tsx scripts/backfill-snapshot-price-context.ts --apply --plan ${PLAN_FILE}`,
    );
  });

  it('prints every path with forward slashes, so a path pastes into Git Bash', () => {
    const backslashed = 'out\\plans\\dry-run-x.json';

    const text = formatReport(dryRunOf(dates, { planFile: backslashed }));

    expect(text).toContain('Plan file: out/plans/dry-run-x.json');
    expect(text).toContain('--apply --plan out/plans/dry-run-x.json');
    expect(text).not.toContain('\\');
  });

  it('ends with what was planned, and how many dates and rows were not, and why', () => {
    const text = formatReport(dryRunOf(dates));

    expect(lastLine(text)).toBe(
      'Planned 3 updates. Not planned: 4 dates with 4 rows (history fetch failed 2, short-candles 1, prev-close-mismatch 1); 3 rows left alone (no-slot 1, before-open 1, bad-candles 1); 1 row with only the previous close and gap right (high/low left as stored).',
    );
  });

  it('warns about a failed fetch before that last line, and names the exit code', () => {
    const text = formatReport(dryRunOf(dates));

    expect(text).toMatch(
      /WARNING: 2 dates not planned because the history fetch failed/,
    );
    expect(text.indexOf('WARNING: 2 dates')).toBeLessThan(
      text.indexOf('Planned 3 updates. Not planned'),
    );
  });

  it('says a re-run will not help an empty history older than the window, only when one is among the failures', () => {
    const withEmpty = formatReport(dryRunOf(dates));
    const only500 = formatReport(
      dryRunOf([
        datePlan(
          BACKTEST_DATE,
          [row(2, '9:00 AM CT', {}, BACKTEST_DATE)],
          'failed',
          null,
          'HTTP 500',
        ),
      ]),
    );

    expect(withEmpty).toContain(
      "1 of them came back empty. A re-run will not help for a date older than Schwab's 5-minute window; it may for a Schwab failure.",
    );
    expect(only500).not.toContain('came back empty');
  });

  it('says it of one failed date, and them of several', () => {
    const failed = (id: number, detail: string) =>
      datePlan(
        BACKTEST_DATE,
        [row(id, '9:00 AM CT', {}, BACKTEST_DATE)],
        'failed',
        null,
        detail,
      );

    const one = formatReport(dryRunOf([failed(1, EMPTY_DETAIL)]));
    const several = formatReport(dryRunOf(dates));

    expect(one).toContain(
      'WARNING: 1 date not planned because the history fetch failed (listed above). The exit code is 1. Re-run for it with --since and --until.',
    );
    expect(one).toContain(
      "  It came back empty. A re-run will not help for a date older than Schwab's 5-minute window",
    );
    expect(several).toContain('Re-run for them with --since and --until.');
  });

  it('says a fetch loop that stopped, how many dates were never tried, and exits 1', () => {
    const failedDays = [
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-11-02',
    ].map((d) =>
      datePlan(d, [row(1, '9:00 AM CT', {}, d)], 'failed', null, 'HTTP 500'),
    );
    const result = dryRunOf(failedDays, {
      untried: ['2026-11-03', '2026-11-05'],
    });

    const text = formatReport(result);

    expect(text).toContain(
      'WARNING: the fetch loop stopped after 5 dates in a row failed with "HTTP 500"; 2 dates were never tried (their rows were not read): 2026-11-03, 2026-11-05. The exit code is 1.',
    );
    expect(lastLine(text)).toMatch(/; 2 dates never tried\.$/);
    expect(text).not.toMatch(/Nothing to write/);
    expect(exitCodeOfDryRun(result)).toBe(1);
  });

  it('never says nothing would change when a date or a row was skipped', () => {
    const skipped = datePlan(
      LIVE_DATE,
      [row(1, 'pre-market')],
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );
    const failed = datePlan(
      BACKTEST_DATE,
      [row(2, '9:00 AM CT', {}, BACKTEST_DATE)],
      'failed',
      null,
      'HTTP 500',
    );

    for (const result of [dryRunOf([skipped]), dryRunOf([failed])]) {
      const text = formatReport(result);

      expect(text).not.toMatch(/Nothing to write|no row would change/);
      expect(lastLine(text)).toMatch(/^Planned 0 updates\. Not planned: /);
    }
    expect(lastLine(formatReport(dryRunOf([skipped])))).toBe(
      'Planned 0 updates. Not planned: 0 dates with 0 rows; 1 row left alone (no-slot 1).',
    );
  });

  it('says nothing is to be written only when every row is already right', () => {
    const right = datePlan(
      LIVE_DATE,
      [
        row(1, '9:00 AM CT', {
          spx_open: '7487.00',
          spx_high: '7505.00',
          spx_low: '7470.00',
          prev_close: '7560.87',
          overnight_gap: '-0.98',
        }),
      ],
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    const text = formatReport(dryRunOf([right]));

    expect(lastLine(text)).toBe(
      'Nothing to write: all 1 row already holds its planned values.',
    );
  });

  describe('when a row with an open sits on bad candles and its previous close and gap are right', () => {
    // Its high and low are not planned (the candles cannot give them), so
    // nothing says they are right: "already holds its planned values" would
    // be a claim about columns the run never checked.
    const stored = {
      spx_open: '7377.65',
      spx_high: '7390.10',
      spx_low: '7370.20',
      prev_close: '7356.73',
      overnight_gap: '0.28',
    };
    const broken: DateHistory = {
      candles: session(BACKTEST_DATE, 78, (i, c) =>
        i === 6 ? { ...c, high: Number.NaN } : c,
      ),
      previousDay: PRIOR_OF_BACKTEST,
    };
    const partly = (...ids: number[]) =>
      datePlan(
        BACKTEST_DATE,
        ids.map((id) => row(id, '9:10 AM CT', stored, BACKTEST_DATE)),
        'ok',
        broken,
      );
    const right = datePlan(
      LIVE_DATE,
      [
        row(1, '9:00 AM CT', {
          spx_open: '7487.00',
          spx_high: '7505.00',
          spx_low: '7470.00',
          prev_close: '7560.87',
          overnight_gap: '-0.98',
        }),
      ],
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    it('says how many hold their planned previous close and gap, with the high and low left as stored', () => {
      expect(lastLine(formatReport(dryRunOf([partly(7)])))).toBe(
        'Nothing to write: 1 row holds its planned previous close and gap, with the high and low left as stored (bad candles).',
      );
      expect(lastLine(formatReport(dryRunOf([partly(7, 8)])))).toBe(
        'Nothing to write: 2 rows hold their planned previous close and gap, with the high and low left as stored (bad candles).',
      );
    });

    it('keeps the rows that are right apart from them', () => {
      const text = formatReport(dryRunOf([right, partly(7)]));

      expect(lastLine(text)).toBe(
        'Nothing to write: 1 row already holds its planned values; 1 row holds its planned previous close and gap, with the high and low left as stored (bad candles).',
      );
      expect(text).toContain(
        'Rows already right (they hold their planned values): 1',
      );
      expect(text).toContain(
        'Rows with only the previous close and gap right, high/low left as stored (bad candles): 1',
      );
      expect(text).toContain(
        '2 rows read = 0 planned + 1 already right + 1 right in previous close and gap only + 0 left alone + 0 on skipped dates',
      );
    });

    it('still names them in the warning, and leaves the plan with no update', () => {
      const text = formatReport(dryRunOf([partly(7)]));

      expect(text).toContain(`${BACKTEST_DATE}: 7`);
      expect(text).toContain('Planned updates: 0');
    });

    it('is a line in the ordinary summary too, when something else is planned', () => {
      const planned = datePlan(
        LIVE_DATE,
        [row(1, '8:35 AM CT')],
        'ok',
        history(LIVE_DATE, PRIOR_OF_LIVE),
      );

      expect(lastLine(formatReport(dryRunOf([planned, partly(7)])))).toBe(
        'Planned 1 update. Not planned: 0 dates with 0 rows; 1 row with only the previous close and gap right (high/low left as stored).',
      );
    });
  });
});

describe('reconcile', () => {
  const rows = [
    row(1, '8:35 AM CT'),
    row(2, 'pre-market'),
    row(3, '10:00 AM CT', {
      spx_open: '7487.00',
      spx_high: '7505.00',
      spx_low: '7470.00',
      prev_close: '7560.87',
      overnight_gap: '-0.98',
    }),
  ];

  it('counts every row read as planned, already right, left alone, or on a skipped date', () => {
    const planned = datePlan(
      LIVE_DATE,
      rows,
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );
    const skipped = datePlan(
      BACKTEST_DATE,
      [row(4, '9:00 AM CT', {}, BACKTEST_DATE)],
      'failed',
      null,
      'HTTP 500',
    );

    expect(reconcile([planned, skipped])).toEqual({
      read: 4,
      planned: 1,
      alreadyRight: 1,
      partlyRight: 0,
      leftAlone: 1,
      onSkippedDates: 1,
    });
  });

  it('throws when a planner drops a row of a planned date', () => {
    const planned = datePlan(
      LIVE_DATE,
      rows,
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    expect(() =>
      reconcile([{ ...planned, results: planned.results.slice(1) }]),
    ).toThrow(
      /do not reconcile: read 3, planned 0, already right 1, left alone 1, on skipped dates 0/,
    );
  });

  it('throws when a planner drops a row that holds its previous close and gap but left its high and low', () => {
    const stored = {
      spx_open: '7377.65',
      spx_high: '7390.10',
      spx_low: '7370.20',
      prev_close: '7356.73',
      overnight_gap: '0.28',
    };
    const broken: DateHistory = {
      candles: session(BACKTEST_DATE, 78, (i, c) =>
        i === 6 ? { ...c, high: Number.NaN } : c,
      ),
      previousDay: PRIOR_OF_BACKTEST,
    };
    const day = datePlan(
      BACKTEST_DATE,
      [
        row(7, '9:10 AM CT', stored, BACKTEST_DATE),
        row(8, '9:15 AM CT', stored, BACKTEST_DATE),
      ],
      'ok',
      broken,
    );

    expect(reconcile([day])).toMatchObject({ read: 2, partlyRight: 2 });
    expect(() =>
      reconcile([{ ...day, results: day.results.slice(1) }]),
    ).toThrow(
      /do not reconcile: read 2, planned 0, already right 0, left alone 0, on skipped dates 0, partly right 1/,
    );
  });

  it('throws when a row is counted twice: a skipped date that still has results', () => {
    const planned = datePlan(
      LIVE_DATE,
      rows,
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    expect(() =>
      reconcile([{ ...planned, skippedDate: 'short-candles' }]),
    ).toThrow(/do not reconcile/);
  });

  it('passes for no dates at all', () => {
    expect(reconcile([])).toEqual({
      read: 0,
      planned: 0,
      alreadyRight: 0,
      partlyRight: 0,
      leftAlone: 0,
      onSkippedDates: 0,
    });
  });

  it('counts a row whose high and low were left as stored apart from one that is right', () => {
    const dateRows = [
      row(1, '9:00 AM CT', {}, BACKTEST_DATE),
      row(2, '9:10 AM CT', {}, BACKTEST_DATE),
    ];
    const plan = datePlan(
      BACKTEST_DATE,
      dateRows,
      'ok',
      history(BACKTEST_DATE, PRIOR_OF_BACKTEST),
    );
    const results: PlanResult[] = [
      { kind: 'skip', id: 1, reason: 'unchanged' },
      { kind: 'skip', id: 2, reason: 'unchanged', highLowLeft: true },
    ];

    expect(reconcile([{ ...plan, results }])).toMatchObject({
      read: 2,
      alreadyRight: 1,
      partlyRight: 1,
    });
  });
});

describe('updatesOf', () => {
  it('lists every planned row with its date and label', () => {
    const planned = datePlan(
      LIVE_DATE,
      [row(1, '8:35 AM CT'), row(2, 'pre-market')],
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    expect(updatesOf([planned])).toEqual([
      expect.objectContaining({
        id: 1,
        date: LIVE_DATE,
        entryTime: '8:35 AM CT',
        fill: 'all',
      }),
    ]);
  });

  it('throws when a planned result has no row, instead of leaving it out of the plan', () => {
    const planned = datePlan(
      LIVE_DATE,
      [row(1, '8:35 AM CT')],
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE),
    );

    expect(() => updatesOf([{ ...planned, rows: [] }])).toThrow(
      /planned row 1 has no row/,
    );
  });
});

// ── Exit codes ──────────────────────────────────────────────────────────────

const applied = (over: Partial<ApplyResult> = {}): ApplyResult => ({
  apply: true,
  file: PLAN_FILE,
  createdAt: '2026-11-18T17:00:00.000Z',
  since: null,
  until: '2026-11-17',
  summary: 'Planned 4 updates.',
  dbHost: 'ep-plan.neon.tech',
  planned: 4,
  written: 4,
  alreadyAppliedIds: [],
  unwrittenIds: [],
  undoFile: 'docs/tmp/snapshot-price-context/undo-x.json',
  reportFile: 'docs/tmp/snapshot-price-context/apply-x.json',
  reportError: null,
  checkError: null,
  ...over,
});

describe('exit codes', () => {
  const ok = datePlan(
    LIVE_DATE,
    [row(1, '8:35 AM CT')],
    'ok',
    history(LIVE_DATE, PRIOR_OF_LIVE),
  );
  const failed = datePlan(
    BACKTEST_DATE,
    [row(2, '9:00 AM CT', {}, BACKTEST_DATE)],
    'failed',
    null,
    EMPTY_DETAIL,
  );
  const undone = (over: Partial<UndoResult> = {}): UndoResult => ({
    apply: true,
    file: 'undo-x.json',
    rows: 4,
    restored: 4,
    changedIds: [],
    ...over,
  });

  it('dry run: 1 when any date failed, an empty history included, else 0', () => {
    expect(exitCodeOfDryRun(dryRunOf([ok, failed]))).toBe(1);
    expect(exitCodeOfDryRun(dryRunOf([ok]))).toBe(0);
    expect(exitCodeOfDryRun(dryRunOf([]))).toBe(0);
  });

  it('dry run: 1 when the fetch loop stopped with dates never tried', () => {
    expect(exitCodeOfDryRun(dryRunOf([ok], { untried: ['2026-11-06'] }))).toBe(
      1,
    );
  });

  it('dry run: skipped rows, short dates and a date that is not a trading day alone do not make it 1', () => {
    const short = datePlan(
      LIVE_DATE,
      [row(1, 'pre-market')],
      'ok',
      history(LIVE_DATE, PRIOR_OF_LIVE, 60),
    );
    const sunday = datePlan(
      '2026-11-08',
      [row(2, '9:00 AM CT', {}, '2026-11-08')],
      'not-fetched',
      null,
    );

    expect(exitCodeOfDryRun(dryRunOf([short, sunday]))).toBe(0);
  });

  it('apply: 1 whenever a planned row was neither written nor already applied', () => {
    expect(exitCodeOfApply(applied())).toBe(0);
    expect(exitCodeOfApply(applied({ written: 3, unwrittenIds: [7] }))).toBe(1);
    expect(
      exitCodeOfApply(applied({ planned: 0, written: 0, undoFile: null })),
    ).toBe(0);
  });

  it('apply: rows already applied by an earlier apply of the plan do not make it 1', () => {
    expect(
      exitCodeOfApply(
        applied({ written: 2, alreadyAppliedIds: [1, 2], unwrittenIds: [] }),
      ),
    ).toBe(0);
    expect(
      exitCodeOfApply(applied({ written: 0, alreadyAppliedIds: [1, 2, 5, 6] })),
    ).toBe(0);
    expect(
      exitCodeOfApply(
        applied({ written: 1, alreadyAppliedIds: [1, 2], unwrittenIds: [5] }),
      ),
    ).toBe(1);
  });

  it('apply: 1 when the apply report could not be written, though the rows were', () => {
    expect(exitCodeOfApply(applied({ reportError: 'disk full' }))).toBe(1);
  });

  it('apply: 0 when only the plan was counted', () => {
    expect(
      exitCodeOfApply(applied({ apply: false, written: 0, undoFile: null })),
    ).toBe(0);
  });

  it('undo: 1 whenever fewer rows were restored than are in the file', () => {
    expect(exitCodeOfUndo(undone())).toBe(0);
    expect(exitCodeOfUndo(undone({ restored: 3, changedIds: [5] }))).toBe(1);
    expect(exitCodeOfUndo(undone({ apply: false, restored: 0 }))).toBe(0);
  });
});

// ── The apply and undo reports ──────────────────────────────────────────────

describe('formatApplyReport', () => {
  const base = applied({
    since: '2026-05-01',
    summary: 'Planned 4 updates. Not planned: 0 dates with 0 rows.',
    written: 3,
    unwrittenIds: [7],
  });

  it('prints the plan it applied, its database, the files, the counts and the unwritten ids', () => {
    const text = formatApplyReport(base);

    expect(text).toContain(`APPLY of ${PLAN_FILE}`);
    expect(text).toContain(
      'Plan made 2026-11-18T17:00:00.000Z against ep-plan.neon.tech',
    );
    expect(text).toContain('2026-05-01 to 2026-11-17');
    expect(text).toContain(`Dry run said: ${base.summary}`);
    expect(text).toContain(`Undo file: ${base.undoFile}`);
    expect(text).toContain(`Apply report: ${base.reportFile}`);
    expect(text).toMatch(/Rows planned:\s+4/);
    expect(text).toMatch(/Rows written:\s+3/);
    expect(lastLine(text)).toBe(
      'Planned 4 rows; written 3; already applied 0; not written 1.',
    );
  });

  it('explains an unwritten row: it did not match the plan, and a fresh dry run is the way on', () => {
    const text = formatApplyReport(base);

    expect(text).toContain(
      "WARNING: 1 planned row was not written: it did not match the plan's before values, because it changed since the dry run or was already written by an earlier apply of this plan. Ids: 7. The exit code is 1. Run a fresh dry run.",
    );
  });

  it('counts rows an earlier apply already wrote apart, and lists them', () => {
    const text = formatApplyReport(
      applied({ written: 2, alreadyAppliedIds: [1, 2], unwrittenIds: [] }),
    );

    expect(text).toContain(
      "Rows already applied (they hold the plan's after values already): 2: 1, 2",
    );
    expect(text).not.toContain('WARNING');
    expect(lastLine(text)).toBe(
      'Planned 4 rows; written 2; already applied 2; not written 0.',
    );
  });

  it('warns that the apply report file failed, with the rows written and the undo file named', () => {
    const text = formatApplyReport(
      applied({ reportFile: null, reportError: 'disk full' }),
    );

    expect(text).toContain(
      'WARNING: the apply report file could not be written: disk full. The rows above were written and the undo file is complete. The exit code is 1.',
    );
    expect(text).toContain(
      `Undo file: docs/tmp/snapshot-price-context/undo-x.json`,
    );
    expect(text).not.toContain('Apply report:');
    expect(text).toMatch(/Rows written:\s+4/);
  });

  it('says when the unwritten rows could not be checked against the plan, in the number of rows', () => {
    const one = formatApplyReport(
      applied({
        written: 3,
        unwrittenIds: [7],
        checkError: 'connection lost',
      }),
    );
    const two = formatApplyReport(
      applied({
        written: 2,
        unwrittenIds: [7, 8],
        checkError: 'connection lost',
      }),
    );

    expect(one).toContain(
      'WARNING: could not check whether the unwritten row was already applied: connection lost. It is listed as not written.',
    );
    expect(two).toContain(
      'WARNING: could not check whether the unwritten rows were already applied: connection lost. They are listed as not written.',
    );
  });

  it('says there was nothing to write for a plan with no updates', () => {
    const text = formatApplyReport(
      applied({
        planned: 0,
        written: 0,
        undoFile: null,
        reportFile: null,
      }),
    );

    expect(text).toContain('Nothing to write: the plan holds no updates');
    expect(text).not.toContain('Undo file');
    expect(lastLine(text)).toBe(
      'Planned 0 rows; written 0; already applied 0; not written 0.',
    );
  });

  it('only counts the plan without --apply', () => {
    const text = formatApplyReport(
      applied({
        apply: false,
        written: 0,
        undoFile: null,
        reportFile: null,
      }),
    );

    expect(text).toContain('DRY RUN: nothing was written');
    expect(text).toContain(`--apply --plan ${PLAN_FILE}`);
    expect(lastLine(text)).toBe('The plan holds 4 rows; nothing written.');
  });

  it('prints every path with forward slashes', () => {
    const text = formatApplyReport(
      applied({
        file: 'out\\p\\dry-run-x.json',
        undoFile: 'out\\p\\undo-x.json',
        reportFile: 'out\\p\\apply-x.json',
      }),
    );

    expect(text).toContain('APPLY of out/p/dry-run-x.json');
    expect(text).toContain('Undo file: out/p/undo-x.json');
    expect(text).toContain('Apply report: out/p/apply-x.json');
    expect(text).not.toContain('\\');
  });
});

describe('formatUndoReport', () => {
  it('lists the rows that were not restored, and ends with the counts', () => {
    const text = formatUndoReport({
      apply: true,
      file: 'undo-x.json',
      rows: 4,
      restored: 3,
      changedIds: [5],
    });

    expect(text).toContain('Rows restored:    3');
    expect(text).toMatch(/WARNING: 1 row no longer held.*: 5\./);
    expect(lastLine(text)).toBe(
      'Rows in the file: 4; restored 3; not restored 1.',
    );
  });

  it('says it of one row that no longer held the values, and they of several', () => {
    const undone = { apply: true, file: 'undo-x.json', rows: 4, restored: 2 };

    const one = formatUndoReport({ ...undone, restored: 3, changedIds: [5] });
    const two = formatUndoReport({ ...undone, changedIds: [5, 6] });

    expect(one).toContain(
      'WARNING: 1 row no longer held the backfilled values (another writer changed it, or the apply never wrote it); it keeps its value: 5. The exit code is 1.',
    );
    expect(two).toContain(
      'WARNING: 2 rows no longer held the backfilled values (another writer changed them, or the apply never wrote them); they keep their value: 5, 6. The exit code is 1.',
    );
  });

  it('only counts the rows without --apply', () => {
    const text = formatUndoReport({
      apply: false,
      file: 'undo-x.json',
      rows: 4,
      restored: 0,
      changedIds: [],
    });

    expect(text).toContain('DRY RUN: nothing was written');
    expect(lastLine(text)).toBe('Rows in the file: 4; nothing restored.');
  });

  it('prints the file path with forward slashes', () => {
    const text = formatUndoReport({
      apply: false,
      file: 'out\\p\\undo-x.json',
      rows: 4,
      restored: 0,
      changedIds: [],
    });

    expect(text).toContain('File: out/p/undo-x.json');
  });
});
