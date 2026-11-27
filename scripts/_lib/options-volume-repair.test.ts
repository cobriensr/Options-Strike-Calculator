// @vitest-environment node

/**
 * The pure part of the options-volume repair
 * (scripts/repair-options-volume.ts -> ./options-volume-repair.ts): reading and
 * refusing the source, which rows a stored date takes its two groups from, what
 * is written and how it is rounded, the comparison with a reviewed plan, the
 * arguments and the report. The SQL runs in options-volume-repair-pglite.test.ts.
 *
 * The source is a small reply. Its rows are one a trading day, and each row's
 * call volume names its date (110000 on 2026-11-10 ... 117000 on 2026-11-17), so a
 * value taken from the wrong row shows. The put volume is twice the call volume
 * and the other fields are the same on every row, so the ratios are known:
 * vol_pcr 2, oi_pcr 1.25, premium_ratio 0.4.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  COLUMNS,
  comparePlan,
  exitCodeOf,
  exitCodeOfUndo,
  formatApplyReport,
  formatReport,
  formatUndoReport,
  parseArgs,
  planRepair,
  readSource,
  USAGE,
  WRITE_CHUNK,
  type RepairPlan,
  type StoredRow,
  type Values,
} from './options-volume-repair.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'options-volume-repair-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let fileCount = 0;
/** Write `content` to a new file in the temp directory and name it. */
function writeFile(content: string): string {
  fileCount += 1;
  const file = join(dir, `source-${fileCount}.json`);
  writeFileSync(file, content);
  return file;
}

/** A reply row as UW sends it: counts as numbers, premiums as strings. */
function uwRow(
  date: string,
  callVolume: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    date,
    call_volume: callVolume,
    put_volume: callVolume * 2,
    call_volume_ask_side: 80000,
    call_volume_bid_side: 70000,
    put_volume_ask_side: 60000,
    put_volume_bid_side: 90000,
    call_premium: '1500000.5000',
    put_premium: '2000000.2500',
    bullish_premium: '800000.0000',
    bearish_premium: '1200000.0000',
    avg_30_day_call_volume: '110000.4333',
    avg_30_day_put_volume: '220000.8',
    call_open_interest: 4_000_000,
    put_open_interest: 5_000_000,
    ...over,
  };
}

/** The smallest and the largest value of an INTEGER column. */
const INT_MIN = -2_147_483_648;
const INT_MAX = 2_147_483_647;

/** The trading days of the fixture, with the call volume that names each. */
const DAYS: ReadonlyArray<readonly [string, number]> = [
  ['2026-11-10', 110_000],
  ['2026-11-11', 111_000],
  ['2026-11-12', 112_000],
  ['2026-11-13', 113_000],
  ['2026-11-16', 116_000],
  ['2026-11-17', 117_000],
];

function sourceFile(
  days: ReadonlyArray<readonly [string, number]> = DAYS,
): string {
  return writeFile(
    JSON.stringify({ data: days.map(([d, v]) => uwRow(d, v)).reverse() }),
  );
}

const NULLS: Values = Object.fromEntries(COLUMNS.map((c) => [c.name, null]));

function stored(date: string, over: Values = {}): StoredRow {
  return { date, values: { ...NULLS, ...over } };
}

function planOf(
  rows: readonly StoredRow[],
  days: ReadonlyArray<readonly [string, number]> = DAYS,
): RepairPlan {
  return planRepair(readSource(sourceFile(days)), rows);
}

/** One date's plan; throws when the plan has none. */
function dateOf(plan: RepairPlan, date: string) {
  const found = plan.dates.find((d) => d.date === date);
  if (found == null) throw new Error(`no plan for ${date}`);
  return found;
}

// ── The source ──────────────────────────────────────────────────────────────

describe('readSource', () => {
  it('reads the rows by their own date, with the span, the count and the hash of the bytes', () => {
    const file = sourceFile();

    const source = readSource(file);

    expect(source.first).toBe('2026-11-10');
    expect(source.last).toBe('2026-11-17');
    expect(source.rows).toBe(6);
    expect([...source.byDate.keys()].sort()).toEqual(DAYS.map(([d]) => d));
    expect(source.byDate.get('2026-11-12')?.call_volume).toBe(112_000);
    expect(source.sha256).toBe(
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    );
  });

  it('gives the same span whatever order the rows come in', () => {
    const ascending = writeFile(
      JSON.stringify({ data: DAYS.map(([d, v]) => uwRow(d, v)) }),
    );

    const source = readSource(ascending);

    expect([source.first, source.last]).toEqual(['2026-11-10', '2026-11-17']);
  });

  it('reads a date sent as a full ISO timestamp, and numbers sent as strings or as numbers', () => {
    const file = writeFile(
      JSON.stringify({
        data: [
          uwRow('2026-11-10T00:00:00.000Z', 110_000, { call_volume: '110000' }),
          uwRow('2026-11-11', 111_000),
        ],
      }),
    );

    const source = readSource(file);

    expect([...source.byDate.keys()].sort()).toEqual([
      '2026-11-10',
      '2026-11-11',
    ]);
  });

  it('keeps fields it does not read, as UW may add them', () => {
    const file = writeFile(
      JSON.stringify({ data: [uwRow('2026-11-10', 110_000, { extra: 1 })] }),
    );

    expect(readSource(file).rows).toBe(1);
  });

  const good = (): Record<string, unknown> => uwRow('2026-11-10', 110_000);
  const without = (key: string) => {
    const row = good();
    delete row[key];
    return row;
  };

  it.each([
    ['text that is not JSON', '{nope', /is not JSON/],
    ['a reply with no data', '{"rows":[]}', /no `data` array/],
    ['data that is not an array', '{"data":{}}', /no `data` array/],
    ['an empty data array', '{"data":[]}', /`data` is empty/],
    ['a row that is a number', '{"data":[7]}', /data\[0\] is not an object/],
    ['a row that is an array', '{"data":[[]]}', /data\[0\] is not an object/],
    ['a row that is null', '{"data":[null]}', /data\[0\] is not an object/],
  ])('refuses %s', (_label, text, why) => {
    const file = writeFile(text);

    expect(() => readSource(file)).toThrow(why);
    expect(() => readSource(file)).toThrow(file);
    expect(() => readSource(file)).toThrow(
      /Nothing was read from the database/,
    );
  });

  it.each([
    ['a row with no date', without('date'), /no usable date/],
    [
      'a date that is a number',
      { ...good(), date: 20261110 },
      /no usable date/,
    ],
    [
      'a date in another form',
      { ...good(), date: '11/10/2026' },
      /no usable date/,
    ],
    [
      'a date off the calendar',
      { ...good(), date: '2026-02-30' },
      /no usable date/,
    ],
    [
      'a date with trailing text',
      { ...good(), date: '2026-11-10x' },
      /no usable date/,
    ],
    [
      'a row with no call_open_interest',
      without('call_open_interest'),
      /no number in call_open_interest/,
    ],
    [
      'a row with no avg_30_day_put_volume',
      without('avg_30_day_put_volume'),
      /no number in avg_30_day_put_volume/,
    ],
    [
      'a field that is text',
      { ...good(), call_premium: 'abc' },
      /no number in call_premium/,
    ],
    [
      'a field that is null',
      { ...good(), put_volume: null },
      /no number in put_volume/,
    ],
    [
      'a field that is empty text',
      { ...good(), bullish_premium: '' },
      /no number in bullish_premium/,
    ],
    [
      'a field that is not finite',
      { ...good(), call_volume: 'Infinity' },
      /no number in call_volume/,
    ],
  ])('refuses %s, naming the row and the field', (_label, row, why) => {
    const file = writeFile(JSON.stringify({ data: [row] }));

    expect(() => readSource(file)).toThrow(why);
    expect(() => readSource(file)).toThrow(/data\[0\]/);
  });

  it('refuses a date that appears twice, however it is written', () => {
    const twice = writeFile(
      JSON.stringify({
        data: [uwRow('2026-11-10', 110_000), uwRow('2026-11-10', 111_000)],
      }),
    );
    const alsoTwice = writeFile(
      JSON.stringify({
        data: [
          uwRow('2026-11-10', 110_000),
          uwRow('2026-11-10T00:00:00.000Z', 111_000),
        ],
      }),
    );

    expect(() => readSource(twice)).toThrow(
      /the date 2026-11-10 appears twice/,
    );
    expect(() => readSource(alsoTwice)).toThrow(/appears twice/);
  });

  it('says so, naming the file, when it cannot be read', () => {
    const missing = join(dir, 'no-such-file.json');

    expect(() => readSource(missing)).toThrow(/cannot read the source/);
    expect(() => readSource(missing)).toThrow(missing);
  });
});

// ── The plan ────────────────────────────────────────────────────────────────

describe('planRepair', () => {
  it('takes opt_* from the date’s row and prev_day_opt_* from the previous trading day’s, through the mapper', () => {
    const plan = planOf([stored('2026-11-12')]);

    const { after, sameDay, previous } = dateOf(plan, '2026-11-12');

    expect(sameDay).toEqual({ kind: 'row', date: '2026-11-12' });
    expect(previous).toEqual({ kind: 'row', date: '2026-11-11' });
    expect(after).toEqual({
      opt_call_volume: '112000',
      opt_put_volume: '224000',
      opt_call_oi: '4000000',
      opt_put_oi: '5000000',
      opt_call_premium: '1500000.50',
      opt_put_premium: '2000000.25',
      opt_bullish_premium: '800000.00',
      opt_bearish_premium: '1200000.00',
      opt_call_vol_ask: '80000',
      opt_put_vol_bid: '90000',
      opt_vol_pcr: '2.0000',
      opt_oi_pcr: '1.2500',
      opt_premium_ratio: '0.4000',
      // 112000 / 110000 and 224000 / 220000, the average read as an integer.
      opt_call_vol_vs_avg30: '1.0182',
      opt_put_vol_vs_avg30: '1.0182',
      prev_day_opt_call_volume: '111000',
      prev_day_opt_put_volume: '222000',
      prev_day_opt_call_oi: '4000000',
      prev_day_opt_put_oi: '5000000',
      prev_day_opt_call_premium: '1500000.50',
      prev_day_opt_put_premium: '2000000.25',
      prev_day_opt_bullish_premium: '800000.00',
      prev_day_opt_bearish_premium: '1200000.00',
      prev_day_opt_call_vol_ask: '80000',
      prev_day_opt_put_vol_bid: '90000',
      prev_day_opt_vol_pcr: '2.0000',
      prev_day_opt_oi_pcr: '1.2500',
      prev_day_opt_premium_ratio: '0.4000',
      prev_day_opt_call_vol_vs_avg30: '1.0091',
      prev_day_opt_put_vol_vs_avg30: '1.0091',
    });
  });

  it('plans a Monday’s previous-day group from the Friday’s row, not from a calendar day', () => {
    const plan = planOf([stored('2026-11-16')]);

    const { after, previous } = dateOf(plan, '2026-11-16');

    expect(previous).toEqual({ kind: 'row', date: '2026-11-13' });
    expect(after.prev_day_opt_call_volume).toBe('113000');
    expect(after.opt_call_volume).toBe('116000');
  });

  it('skips a market holiday when it takes the previous trading day', () => {
    // 2026-11-26 is Thanksgiving: the day after, Fri 11-27, takes Wed 11-25.
    const days = [
      ['2026-11-24', 124_000],
      ['2026-11-25', 125_000],
      ['2026-11-27', 127_000],
    ] as const;

    const plan = planOf([stored('2026-11-27')], days);

    expect(dateOf(plan, '2026-11-27').previous).toEqual({
      kind: 'row',
      date: '2026-11-25',
    });
    expect(dateOf(plan, '2026-11-27').after.prev_day_opt_call_volume).toBe(
      '125000',
    );
  });

  it('leaves the previous-day group alone when the previous trading day is before the span, and writes the other group', () => {
    const plan = planOf([
      stored('2026-11-10', {
        prev_day_opt_call_volume: '999',
        prev_day_opt_vol_pcr: '9.0000',
      }),
    ]);

    const date = dateOf(plan, '2026-11-10');

    expect(date.previous).toEqual({ kind: 'outside-span', date: '2026-11-09' });
    expect(date.after.prev_day_opt_call_volume).toBe('999');
    expect(date.after.prev_day_opt_vol_pcr).toBe('9.0000');
    expect(date.after.opt_call_volume).toBe('110000');
    expect(date.changed.every((name) => name.startsWith('opt_'))).toBe(true);
    expect(date.changed).toHaveLength(15);
  });

  it('sets a group to NULL, and says so, when its source row is missing inside the span', () => {
    // No row for Wed 11-11, though the span runs past it.
    const hole = DAYS.filter(([d]) => d !== '2026-11-11');
    const full = Object.fromEntries(
      COLUMNS.map((c) => [c.name, c.kind === 'int' ? '7' : '7.0000']),
    );

    const plan = planOf(
      [stored('2026-11-11', full), stored('2026-11-12', full)],
      hole,
    );

    const eleventh = dateOf(plan, '2026-11-11');
    expect(eleventh.sameDay).toEqual({
      kind: 'no-source-row',
      date: '2026-11-11',
    });
    expect(
      COLUMNS.filter((c) => c.prefix === 'opt_').every(
        (c) => eleventh.after[c.name] === null,
      ),
    ).toBe(true);
    // Its previous day, Tue 11-10, has a row.
    expect(eleventh.previous).toEqual({ kind: 'row', date: '2026-11-10' });
    expect(eleventh.after.prev_day_opt_call_volume).toBe('110000');
    const twelfth = dateOf(plan, '2026-11-12');
    expect(twelfth.previous).toEqual({
      kind: 'no-source-row',
      date: '2026-11-11',
    });
    expect(
      COLUMNS.filter((c) => c.prefix === 'prev_day_opt_').every(
        (c) => twelfth.after[c.name] === null,
      ),
    ).toBe(true);
    expect(twelfth.after.opt_call_volume).toBe('112000');
  });

  it('lists a date outside the span and leaves it out of the plan', () => {
    const plan = planOf([
      stored('2026-11-09'),
      stored('2026-11-10'),
      stored('2026-11-17'),
      stored('2026-11-18'),
    ]);

    expect(plan.outsideSpan).toEqual(['2026-11-09', '2026-11-18']);
    expect(plan.dates.map((d) => d.date)).toEqual(['2026-11-10', '2026-11-17']);
  });

  it('carries the source’s fingerprint', () => {
    const file = sourceFile();

    const plan = planRepair(readSource(file), []);

    expect(plan.source).toEqual({
      sha256: readSource(file).sha256,
      rows: 6,
      first: '2026-11-10',
      last: '2026-11-17',
    });
  });

  describe('exact writes', () => {
    it('plans no change for a date that already holds the values, and a second plan from the written values is empty', () => {
      const first = planOf([stored('2026-11-12'), stored('2026-11-13')]);
      const written = first.dates.map((d) => stored(d.date, d.after));

      const second = planOf(written);

      expect(first.dates.every((d) => d.changed.length > 0)).toBe(true);
      expect(second.dates.map((d) => d.changed)).toEqual([[], []]);
    });

    it('compares a stored ratio at its own scale: 360136/282619 is 1.2743 against a stored 1.2743', () => {
      const days = [
        ['2026-11-24', 282_619],
        ['2026-11-25', 282_619],
      ] as const;
      // Rows whose put volume is 360136 where the call volume is 282619.
      const file = writeFile(
        JSON.stringify({
          data: days.map(([d, v]) => uwRow(d, v, { put_volume: 360_136 })),
        }),
      );
      const source = readSource(file);
      const computed = planRepair(source, [stored('2026-11-25')]);
      expect(dateOf(computed, '2026-11-25').after.opt_vol_pcr).toBe('1.2743');

      const again = planRepair(source, [
        stored('2026-11-25', dateOf(computed, '2026-11-25').after),
      ]);

      expect(dateOf(again, '2026-11-25').changed).toEqual([]);
    });

    it('reads a stored value written at another scale as the same number: 2 for a ratio, 1500000.5 for a premium', () => {
      const exact = dateOf(planOf([stored('2026-11-12')]), '2026-11-12').after;

      const plan = planOf([
        stored('2026-11-12', {
          ...exact,
          opt_vol_pcr: '2',
          opt_call_premium: '1500000.5',
          opt_call_volume: '112000',
        }),
      ]);

      expect(dateOf(plan, '2026-11-12').changed).toEqual([]);
    });

    it('rounds half away from zero on the decimal text, as Postgres does, not on the binary value', () => {
      // 300010 / 200000 is 1.50005 (toFixed(4) says 1.5000, the text rounds up)
      // and 1234.565 is 1234.57 (toFixed(2) says 1234.56).
      const file = writeFile(
        JSON.stringify({
          data: [
            uwRow('2026-11-24', 200_000),
            uwRow('2026-11-25', 200_000, {
              put_volume: 300_010,
              call_premium: '1234.565',
            }),
          ],
        }),
      );

      const plan = planRepair(readSource(file), [stored('2026-11-25')]);

      const { after } = dateOf(plan, '2026-11-25');
      expect(after.opt_vol_pcr).toBe('1.5001');
      expect(after.opt_call_premium).toBe('1234.57');
    });

    it('replaces a stored NaN or Infinity, which no planned value equals', () => {
      const exact = dateOf(planOf([stored('2026-11-12')]), '2026-11-12').after;

      const plan = planOf([
        stored('2026-11-12', {
          ...exact,
          opt_vol_pcr: 'NaN',
          prev_day_opt_oi_pcr: 'Infinity',
        }),
      ]);

      const date = dateOf(plan, '2026-11-12');
      expect(date.changed).toEqual(['opt_vol_pcr', 'prev_day_opt_oi_pcr']);
      expect(date.before.opt_vol_pcr).toBe('NaN');
      expect(date.after.opt_vol_pcr).toBe('2.0000');
    });

    it('reads a stored value at its column’s scale and with its sign, with no negative zero, and keeps what is not a number as it is', () => {
      const exact = dateOf(planOf([stored('2026-11-12')]), '2026-11-12').after;

      const plan = planOf([
        stored('2026-11-12', {
          ...exact,
          opt_vol_pcr: '-1.5',
          opt_oi_pcr: '-0.00001',
          opt_call_volume: '5.5',
          opt_put_volume: ' 224000 ',
          opt_call_premium: '',
        }),
      ]);

      const { before, changed } = dateOf(plan, '2026-11-12');
      expect(before.opt_vol_pcr).toBe('-1.5000');
      // Under half a unit of the scale, so zero: written without a sign.
      expect(before.opt_oi_pcr).toBe('0.0000');
      expect(before.opt_call_volume).toBe('5.5');
      expect(before.opt_put_volume).toBe('224000');
      expect(before.opt_call_premium).toBe('');
      expect(changed).toEqual([
        'opt_call_volume',
        'opt_call_premium',
        'opt_vol_pcr',
        'opt_oi_pcr',
      ]);
    });

    it('sets a column to NULL, replacing a stored value, when the source says NULL: a zero count, a ratio with no denominator', () => {
      const days = [
        ['2026-11-10', 110_000],
        ['2026-11-11', 0],
      ] as const;
      const old = {
        opt_call_volume: '5',
        opt_vol_pcr: '3.0000',
        opt_call_vol_vs_avg30: '1.0000',
      };

      const plan = planOf([stored('2026-11-11', old)], days);

      const date = dateOf(plan, '2026-11-11');
      expect(date.after.opt_call_volume).toBeNull();
      // call volume 0: no vol_pcr, and a ratio of 0 over the average is 0.
      expect(date.after.opt_vol_pcr).toBeNull();
      expect(date.after.opt_call_vol_vs_avg30).toBe('0.0000');
      expect(date.changed).toEqual(
        expect.arrayContaining(['opt_call_volume', 'opt_vol_pcr']),
      );
    });
  });

  describe('a value its column cannot hold stops the run, naming the date and the column', () => {
    const planWith = (over: Record<string, unknown>) => {
      const file = writeFile(
        JSON.stringify({
          data: [
            uwRow('2026-11-10', 110_000),
            uwRow('2026-11-11', 111_000, over),
          ],
        }),
      );
      return () => planRepair(readSource(file), [stored('2026-11-11')]);
    };

    it.each([
      [
        'a ratio of 100 or more',
        { put_volume: 100_000_000, call_volume: 1 },
        /opt_vol_pcr: .* does not fit DECIMAL\(6,4\)/,
      ],
      [
        'a ratio that rounds up to 100',
        { call_volume: 100_000, put_volume: 9_999_995 },
        /opt_vol_pcr: .* does not fit DECIMAL\(6,4\)/,
      ],
      [
        'a premium of 1e12 or more',
        { call_premium: '1000000000000' },
        /opt_call_premium: .* does not fit DECIMAL\(14,2\)/,
      ],
      [
        'a count past INTEGER',
        { call_volume: 3_000_000_000 },
        /opt_call_volume: .* does not fit INTEGER/,
      ],
      [
        'a count one past INTEGER',
        { call_volume: INT_MAX + 1 },
        /opt_call_volume: .* does not fit INTEGER/,
      ],
      [
        'a count one below INTEGER',
        { call_open_interest: INT_MIN - 1 },
        /opt_call_oi: .* does not fit INTEGER/,
      ],
      [
        'a premium so large its text has an exponent',
        { call_premium: '1e21' },
        /opt_call_premium: .* is not a value a column holds/,
      ],
    ])('%s', (_label, over, why) => {
      expect(planWith(over)).toThrow(why);
      expect(planWith(over)).toThrow(/2026-11-11/);
      expect(planWith(over)).toThrow(/Nothing was written/);
    });

    it('takes the largest values the columns hold', () => {
      const plan = planWith({
        call_volume: 100_000,
        put_volume: 9_999_994, // 99.99994 rounds to 99.9999
        call_premium: '999999999999.99',
        call_open_interest: INT_MAX,
      })();

      const { after } = dateOf(plan, '2026-11-11');
      expect(after.opt_vol_pcr).toBe('99.9999');
      expect(after.opt_call_premium).toBe('999999999999.99');
      expect(after.opt_call_oi).toBe(String(INT_MAX));
    });

    it('takes the smallest count INTEGER holds', () => {
      const plan = planWith({ call_open_interest: INT_MIN })();

      expect(dateOf(plan, '2026-11-11').after.opt_call_oi).toBe(
        String(INT_MIN),
      );
    });

    it('rounds a premium so small its text has an exponent to zero, not to an error', () => {
      const plan = planWith({ call_premium: '0.0000001' })();

      expect(dateOf(plan, '2026-11-11').after.opt_call_premium).toBe('0.00');
    });
  });
});

// ── Comparing with the reviewed plan ────────────────────────────────────────

describe('comparePlan', () => {
  /** The plan, and the file a dry run would have written for it. */
  function reviewed(rows: readonly StoredRow[]) {
    const plan = planOf(rows);
    const file = {
      source: plan.source,
      rows: plan.dates
        .filter((d) => d.changed.length > 0)
        .map((d) => ({ date: d.date, before: d.before, after: d.after })),
    };
    return { plan, file };
  }

  const ROWS = [stored('2026-11-12'), stored('2026-11-13')];

  it('finds nothing when the fresh plan is the file’s', () => {
    const { plan, file } = reviewed(ROWS);

    expect(comparePlan(file, plan)).toEqual([]);
  });

  it('says so when a date is planned now that the file did not list', () => {
    const { file } = reviewed(ROWS);
    const fresh = planOf([...ROWS, stored('2026-11-16')]);

    expect(comparePlan(file, fresh)).toEqual([
      '2026-11-16 is planned now and is not in the file',
    ]);
  });

  it('says so when the stored values changed since the dry run, naming a column', () => {
    const { file } = reviewed(ROWS);
    const fresh = planOf([
      stored('2026-11-12', { opt_call_volume: '42' }),
      ROWS[1]!,
    ]);

    const problems = comparePlan(file, fresh);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /2026-11-12: the stored values changed since the dry run/,
    );
    expect(problems[0]).toMatch(/opt_call_volume NULL then, 42 now/);
  });

  it('says so when the new values differ from the file’s', () => {
    const { file } = reviewed(ROWS);
    const edited = {
      ...file,
      rows: file.rows.map((r) =>
        r.date === '2026-11-13'
          ? { ...r, after: { ...r.after, opt_vol_pcr: '9.0000' } }
          : r,
      ),
    };
    const fresh = planOf(ROWS);

    const problems = comparePlan(edited, fresh);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /2026-11-13: the new values differ from the file's/,
    );
  });

  it('accepts a listed date that already holds the file’s new values: a second apply writes nothing', () => {
    const { plan, file } = reviewed(ROWS);
    const written = planOf(plan.dates.map((d) => stored(d.date, d.after)));

    expect(comparePlan(file, written)).toEqual([]);
  });

  it('says so when a listed date is no longer read', () => {
    const { file } = reviewed(ROWS);
    const gone = planOf([ROWS[0]!]);

    expect(comparePlan(file, gone)).toEqual([
      '2026-11-13 is in the file and is no longer planned (it is no longer read)',
    ]);
  });

  it('says so when a listed date is already right, but not with the values the file says it writes', () => {
    const { plan, file } = reviewed(ROWS);
    const edited = {
      ...file,
      rows: file.rows.map((r) =>
        r.date === '2026-11-13'
          ? { ...r, after: { ...r.after, opt_vol_pcr: '9.0000' } }
          : r,
      ),
    };
    const written = planOf(plan.dates.map((d) => stored(d.date, d.after)));

    expect(comparePlan(edited, written)).toEqual([
      '2026-11-13 is in the file and is no longer planned (it holds other values than the file writes)',
    ]);
  });

  it('says so when the source is not the one the plan was made from', () => {
    const { plan, file } = reviewed(ROWS);
    const other = {
      ...file,
      source: { ...file.source, sha256: 'a'.repeat(64) },
    };

    const problems = comparePlan(other, plan);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /the source file is not the one the plan was made from/,
    );
  });
});

// ── Exit codes ──────────────────────────────────────────────────────────────

describe('exit codes', () => {
  const plan = planOf([]);
  const base = {
    apply: true,
    plan,
    scope: { date: null, since: null, until: null },
    backupFile: null,
    planFile: null,
    database: 'host/db',
  };

  it.each([
    ['a dry run', null, 0],
    [
      'an apply that wrote every planned date',
      { backupFile: 'b', planned: 2, written: 2, changedSinceRead: [] },
      0,
    ],
    [
      'an apply with nothing to write',
      { backupFile: null, planned: 0, written: 0, changedSinceRead: [] },
      0,
    ],
    [
      'an apply that wrote fewer than it planned',
      { backupFile: 'b', planned: 2, written: 1, changedSinceRead: [] },
      1,
    ],
    [
      'an apply with a date that changed since the read',
      {
        backupFile: 'b',
        planned: 2,
        written: 2,
        changedSinceRead: ['2026-11-12'],
      },
      1,
    ],
  ])('exitCodeOf: %s', (_label, applied, code) => {
    expect(exitCodeOf({ ...base, applied })).toBe(code);
  });

  it.each([
    ['a count', { apply: false, rows: 3, restored: 0, changedSince: [] }, 0],
    [
      'an undo that restored all',
      { apply: true, rows: 3, restored: 3, changedSince: [] },
      0,
    ],
    [
      'an undo that restored fewer',
      { apply: true, rows: 3, restored: 2, changedSince: [] },
      1,
    ],
    [
      'an undo with a date changed since',
      { apply: true, rows: 3, restored: 3, changedSince: ['2026-11-12'] },
      1,
    ],
  ])('exitCodeOfUndo: %s', (_label, result, code) => {
    expect(exitCodeOfUndo({ ...result, database: 'host/db' })).toBe(code);
  });
});

// ── Arguments ───────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('reads a dry run of every date', () => {
    expect(parseArgs(['--source', 'reply.json'])).toMatchObject({
      source: 'reply.json',
      apply: false,
      all: false,
      date: null,
      planFile: null,
      undoFile: null,
      help: false,
    });
  });

  it('reads every flag', () => {
    const args = parseArgs([
      '--source',
      'reply.json',
      '--apply',
      '--all',
      '--plan',
      'plan.json',
      '--backup-dir',
      'out',
      '--env-file',
      'env',
    ]);

    expect(args).toMatchObject({
      source: 'reply.json',
      apply: true,
      all: true,
      planFile: 'plan.json',
      backupDir: 'out',
      envFile: 'env',
    });
  });

  it('reads a date, or a range, and a restore needing no source', () => {
    expect(parseArgs(['--source', 's', '--date', '2026-11-12']).date).toBe(
      '2026-11-12',
    );
    expect(
      parseArgs([
        '--source',
        's',
        '--since',
        '2026-11-10',
        '--until',
        '2026-11-12',
      ]),
    ).toMatchObject({
      since: '2026-11-10',
      until: '2026-11-12',
    });
    expect(parseArgs(['--undo-file', 'b.json', '--apply'])).toMatchObject({
      undoFile: 'b.json',
      apply: true,
      source: null,
    });
  });

  it('prints the help, whatever else is said', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h', '--apply']).help).toBe(true);
    expect(USAGE).toMatch(/--source <f>/);
  });

  it.each([
    ['no source', [], /--source <file> is required/],
    ['a source with no value', ['--source'], /--source needs a value/],
    [
      'a source followed by a flag',
      ['--source', '--apply'],
      /--source needs a value/,
    ],
    [
      'an unknown flag',
      ['--source', 's', '--frobnicate'],
      /unknown argument --frobnicate/,
    ],
    [
      'a date that is not a date',
      ['--source', 's', '--date', '2026-02-30'],
      /--date must be a real date/,
    ],
    [
      'a date in another form',
      ['--source', 's', '--since', '11/12/2026'],
      /--since must be a real date/,
    ],
    [
      '--dry-run with --apply',
      ['--source', 's', '--dry-run', '--apply', '--plan', 'p'],
      /contradict each other/,
    ],
    [
      '--date with --since',
      ['--source', 's', '--date', '2026-11-12', '--since', '2026-11-10'],
      /--date cannot be combined/,
    ],
    [
      '--plan with --date',
      ['--source', 's', '--plan', 'p', '--date', '2026-11-12'],
      /--plan names its own scope/,
    ],
    [
      '--plan with --undo-file',
      ['--source', 's', '--plan', 'p', '--undo-file', 'b'],
      /--plan names its own scope/,
    ],
    [
      '--undo-file with --source',
      ['--undo-file', 'b', '--source', 's'],
      /--undo-file restores a backup/,
    ],
    [
      '--apply with no plan',
      ['--source', 's', '--apply'],
      /Refusing to apply without --plan/,
    ],
    [
      '--all with no apply',
      ['--source', 's', '--plan', 'p', '--all'],
      /--all only confirms --apply --plan/,
    ],
    [
      '--all with no plan',
      ['--source', 's', '--apply', '--all'],
      /Refusing to apply without --plan/,
    ],
  ])('refuses %s', (_label, argv, why) => {
    expect(() => parseArgs(argv)).toThrow(why);
  });
});

// ── The report ──────────────────────────────────────────────────────────────

describe('formatReport', () => {
  const scope = { date: null, since: null, until: null };

  it('prints the counts, a line per date naming its sources, and every changed value as stored then new', () => {
    const exact = dateOf(planOf([stored('2026-11-13')]), '2026-11-13').after;
    const plan = planOf([
      stored('2026-11-12', { opt_call_volume: '5' }),
      stored('2026-11-13', exact),
      stored('2026-11-18'),
    ]);

    const text = formatReport({ plan, scope, planFile: 'plan.json' });

    expect(text).toContain('Source: 6 rows, 2026-11-10 to 2026-11-17 (sha256 ');
    expect(text).toContain('Scope: all');
    expect(text).toContain(
      'training_features dates read: 3 (2 inside the span, 1 outside it)',
    );
    expect(text).toContain(
      'Planned: 1 dates to write (30 column values), 1 already right',
    );
    expect(text).toMatch(
      /2026-11-12 {2}change 30 columns {2}\[opt_: row 2026-11-12; prev_day_opt_: row 2026-11-11\]/,
    );
    expect(text).toMatch(/2026-11-13 {2}right /);
    expect(text).toContain('    opt_call_volume: 5 -> 112000');
    expect(text).toContain('    opt_oi_pcr: NULL -> 1.2500');
    expect(text).toContain('Outside the span, left untouched (1): 2026-11-18');
    expect(text).toContain('Plan file: plan.json');
  });

  it('lists the dates left alone or set to NULL, and cuts a long list', () => {
    const plan = planOf(
      [stored('2026-11-10'), stored('2026-11-11'), stored('2026-11-12')],
      DAYS.filter(([d]) => d !== '2026-11-11'),
    );

    const text = formatReport({ plan, scope, planFile: null });

    expect(text).toContain(
      'Previous trading day outside the span, prev_day_opt_* left untouched (1): 2026-11-10',
    );
    expect(text).toContain(
      'No source row for the date, opt_* set to NULL (1): 2026-11-11',
    );
    expect(text).toContain(
      'No source row for the previous trading day, prev_day_opt_* set to NULL (1): 2026-11-12',
    );
    expect(text).not.toContain('Plan file:');

    const many = planOf(
      Array.from({ length: 15 }, (_, i) =>
        stored(`2027-02-${String(i + 10).padStart(2, '0')}`),
      ),
    );
    expect(formatReport({ plan: many, scope, planFile: null })).toContain(
      'Outside the span, left untouched (15): 2027-02-10, 2027-02-11, 2027-02-12, 2027-02-13, 2027-02-14, 2027-02-15, 2027-02-16, 2027-02-17, 2027-02-18, 2027-02-19, 2027-02-20, 2027-02-21, and 3 more',
    );
  });

  it('names a scope of one date and of a range', () => {
    const plan = planOf([]);

    expect(
      formatReport({
        plan,
        scope: { date: '2026-11-12', since: null, until: null },
        planFile: null,
      }),
    ).toContain('Scope: 2026-11-12');
    expect(
      formatReport({
        plan,
        scope: { date: null, since: '2026-11-10', until: null },
        planFile: null,
      }),
    ).toContain('Scope: 2026-11-10..last');
  });
});

describe('formatApplyReport and formatUndoReport', () => {
  it('says what was written, the backup, and the dates that changed since the read', () => {
    expect(
      formatApplyReport({
        backupFile: 'b.json',
        planned: 3,
        written: 2,
        changedSinceRead: ['2026-11-12'],
      }),
    ).toBe(
      'Wrote 2 of 3 planned dates.\nBackup: b.json\nChanged since the read, not written (1): 2026-11-12',
    );
    expect(
      formatApplyReport({
        backupFile: null,
        planned: 0,
        written: 0,
        changedSinceRead: [],
      }),
    ).toBe('Nothing to write: every date is already right.');
  });

  it('says what an undo counted or restored', () => {
    expect(
      formatUndoReport({
        apply: false,
        rows: 3,
        restored: 0,
        changedSince: [],
        database: 'h/d',
      }),
    ).toMatch(/The backup holds 3 dates\. Add --apply/);
    expect(
      formatUndoReport({
        apply: true,
        rows: 3,
        restored: 2,
        changedSince: ['2026-11-12'],
        database: 'h/d',
      }),
    ).toBe(
      'Restored 2 of 3 dates.\nChanged since the repair, not restored (1): 2026-11-12',
    );
  });
});

describe('the write size', () => {
  it('is 500 dates to a statement', () => {
    expect(WRITE_CHUNK).toBe(500);
  });
});
