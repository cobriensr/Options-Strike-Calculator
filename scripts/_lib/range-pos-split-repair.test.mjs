// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { WRITE_BATCH } from './backfill-cli.mjs';
import { chunk, computeRangePos } from './range-pos-backfill.mjs';
import {
  BACKUP_DIR,
  BACKUP_VERSION,
  SPLIT_REPAIRS,
  backupFileName,
  backupPath,
  buildBackup,
  formatDayLine,
  formatTickerReport,
  groupByDay,
  parseBackup,
  parseRepairArgs,
  pickSamples,
  planRow,
  planTickerDay,
  summarizeTicker,
  undoPlan,
  valueSpread,
  verifyBackupText,
  writableRows,
} from './range-pos-split-repair.mjs';

// Real fires from the spec's hand checks. UW answers candles newest first,
// adjusted for the later split; the stored spot is the price at the time.
const CRWD = SPLIT_REPAIRS[0];
const SOXS = SPLIT_REPAIRS[1];

const CRWD_TRIGGER = '2026-05-19T13:30:54.000Z';
const CRWD_CANDLES = [
  { start_time: '2026-05-19T13:31:00Z', high: '700', low: '600' }, // after the trigger
  { start_time: '2026-05-19T13:30:00Z', high: '155.88', low: 154.2 },
  { start_time: '2026-05-19T13:29:00Z', high: 154.9, low: '153.25' },
];
const SOXS_TRIGGER = '2026-07-10T18:35:37.000Z';
const SOXS_CANDLES = [
  { start_time: '2026-07-10T18:35:00Z', high: '43.9', low: '41.5' },
  { start_time: '2026-07-10T18:34:00Z', high: 42.1, low: '39.8' },
];

const crwdRow = (overrides = {}) => ({
  id: '647842',
  ticker: 'CRWD',
  date: '2026-05-19',
  trigger_time_ct: CRWD_TRIGGER,
  spot: 620.49,
  old: '1',
  ...overrides,
});
const soxsRow = (overrides = {}) => ({
  id: '844453',
  ticker: 'SOXS',
  date: '2026-07-10',
  trigger_time_ct: SOXS_TRIGGER,
  spot: 4.0701,
  old: '0',
  ...overrides,
});

describe('SPLIT_REPAIRS', () => {
  it('lists CRWD and SOXS with the measured windows and scales', () => {
    expect(
      SPLIT_REPAIRS.map(({ ticker, from, to, spotScale }) => ({
        ticker,
        from,
        to,
        spotScale,
      })),
    ).toEqual([
      { ticker: 'CRWD', from: '2026-05-18', to: '2026-07-01', spotScale: 0.25 },
      { ticker: 'SOXS', from: '2026-05-18', to: '2026-07-10', spotScale: 10 },
    ]);
  });

  it('carries a one-line note of the split and its evidence', () => {
    for (const repair of SPLIT_REPAIRS) {
      expect(repair.note).toMatch(/^[^\n]+$/);
    }
    expect(CRWD.note).toContain('3.986');
    expect(CRWD.note).toContain('4.019');
    expect(SOXS.note).toContain('0.1000');
    expect(SOXS.note).toContain('0.1008');
  });

  it('is frozen, entries included', () => {
    expect(Object.isFrozen(SPLIT_REPAIRS)).toBe(true);
    for (const repair of SPLIT_REPAIRS) {
      expect(Object.isFrozen(repair)).toBe(true);
    }
  });
});

describe('planRow: the four cases', () => {
  it('case 1: a spot inside the pre-trigger range is not a split artifact and is left alone', () => {
    const plan = planRow(
      crwdRow({ spot: 154.5, old: '0.4' }),
      CRWD_CANDLES,
      CRWD.spotScale,
    );
    expect(plan).toMatchObject({
      id: '647842',
      outcome: 'notArtifact',
      old: '0.4',
    });
  });

  it('case 2: a raw spot that fails the guard is repaired from spot × scale (CRWD 620.49 → 0.712)', () => {
    const plan = planRow(crwdRow(), CRWD_CANDLES, CRWD.spotScale);
    expect(plan.outcome).toBe('repaired');
    expect(plan.scaledSpot).toBe(620.49 * 0.25);
    expect(plan.next).toBe(
      computeRangePos(CRWD_CANDLES, CRWD_TRIGGER, 620.49 * 0.25),
    );
    expect(plan.next).toBeCloseTo(0.712, 3);
    expect(plan.low).toBe(153.25);
    expect(plan.high).toBe(155.88);
    expect(plan.old).toBe('1');
  });

  it('case 2: SOXS reverse split, 4.0701 × 10 → 0.220', () => {
    const plan = planRow(soxsRow(), SOXS_CANDLES, SOXS.spotScale);
    expect(plan.outcome).toBe('repaired');
    expect(plan.next).toBeCloseTo(0.22, 2);
    expect(plan.scaledSpot).toBe(4.0701 * 10);
  });

  it('case 2: a scaled spot that passes the guard but is a flat range gives a null result, which is a blank', () => {
    const flat = [
      { start_time: '2026-05-19T13:29:00Z', high: '155', low: '155' },
    ];
    const plan = planRow(crwdRow({ spot: 620 }), flat, CRWD.spotScale);
    expect(plan).toMatchObject({ outcome: 'blanked', next: null });
    expect(plan.scaledSpot).toBe(155);
  });

  it('case 3: a spot that fails the guard raw and scaled is blanked', () => {
    const plan = planRow(
      crwdRow({ spot: 100_000 }),
      CRWD_CANDLES,
      CRWD.spotScale,
    );
    expect(plan).toMatchObject({ outcome: 'blanked', next: null, old: '1' });
  });

  it('keeps a scaled spot exactly at high × 1.2 inside the guard, clamped to 1', () => {
    const high = 155.88;
    const plan = planRow(
      crwdRow({ spot: (high * 1.2) / CRWD.spotScale }),
      CRWD_CANDLES,
      CRWD.spotScale,
    );
    expect(plan.outcome).toBe('repaired');
    expect(plan.next).toBe(1);
  });

  it('does not let a later candle rescue a scaled spot', () => {
    const candles = [
      { start_time: '2026-05-19T13:35:00Z', high: '650', low: '600' },
      ...CRWD_CANDLES.slice(1),
    ];
    // 2,400 × 0.25 = 600 sits inside only the later candle (600 to 650).
    const plan = planRow(crwdRow({ spot: 2_400 }), candles, CRWD.spotScale);
    expect(plan.outcome).toBe('blanked');
  });

  it('gives the same plan for newest-first and oldest-first candles', () => {
    expect(
      planRow(crwdRow(), [...CRWD_CANDLES].reverse(), CRWD.spotScale),
    ).toEqual(planRow(crwdRow(), CRWD_CANDLES, CRWD.spotScale));
  });

  it('takes a Date trigger like an ISO one', () => {
    const asDate = planRow(
      crwdRow({ trigger_time_ct: new Date(CRWD_TRIGGER) }),
      CRWD_CANDLES,
      CRWD.spotScale,
    );
    expect(asDate.next).toBe(
      planRow(crwdRow(), CRWD_CANDLES, CRWD.spotScale).next,
    );
  });
});

describe('planRow: edge spots', () => {
  it.each([
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'a %s spot passes the raw guard, so it is notArtifact and stays untouched',
    (_label, spot) => {
      const plan = planRow(crwdRow({ spot }), CRWD_CANDLES, CRWD.spotScale);
      expect(plan.outcome).toBe('notArtifact');
    },
  );

  it.each([
    ['zero', 0],
    ['negative', -5],
  ])(
    'a %s spot fails the raw and the scaled check, so it is blanked',
    (_label, spot) => {
      const plan = planRow(crwdRow({ spot }), CRWD_CANDLES, CRWD.spotScale);
      expect(plan).toMatchObject({ outcome: 'blanked', next: null });
    },
  );

  it('leaves a row alone when no candle precedes its trigger (nothing to judge it by)', () => {
    const plan = planRow(
      crwdRow(),
      [{ start_time: '2026-05-19T14:00:00Z', high: '160', low: '150' }],
      CRWD.spotScale,
    );
    expect(plan.outcome).toBe('notArtifact');
  });
});

describe('planTickerDay', () => {
  const rows = [crwdRow(), crwdRow({ id: '2', spot: 154.5, old: '0.3' })];

  it('plans every row of a day UW answered', () => {
    const { plans, failure } = planTickerDay(
      rows,
      { kind: 'ok', candles: CRWD_CANDLES },
      CRWD.spotScale,
    );
    expect(failure).toBeNull();
    expect(plans.map((p) => p.outcome)).toEqual(['repaired', 'notArtifact']);
  });

  it('leaves the day untouched and names the failure on a UW error', () => {
    const { plans, failure } = planTickerDay(
      rows,
      { kind: 'error', status: 'http_503', detail: 'upstream down' },
      CRWD.spotScale,
    );
    expect(plans).toEqual([]);
    expect(failure).toEqual({ status: 'http_503', detail: 'upstream down' });
  });

  it('treats an empty day as a failure too, with its own status', () => {
    const { plans, failure } = planTickerDay(
      rows,
      { kind: 'empty' },
      CRWD.spotScale,
    );
    expect(plans).toEqual([]);
    expect(failure).toEqual({
      status: 'empty',
      detail: 'UW returned no candles',
    });
  });
});

describe('groupByDay', () => {
  it('groups rows by ticker and date, in a stable order', () => {
    const rows = [
      crwdRow({ id: '1', date: '2026-05-20' }),
      soxsRow({ id: '2' }),
      crwdRow({ id: '3', date: '2026-05-19' }),
      crwdRow({ id: '4', date: '2026-05-20' }),
    ];
    const days = groupByDay(rows);
    expect(
      days.map((d) => [d.ticker, d.date, d.rows.map((r) => r.id)]),
    ).toEqual([
      ['CRWD', '2026-05-19', ['3']],
      ['CRWD', '2026-05-20', ['1', '4']],
      ['SOXS', '2026-07-10', ['2']],
    ]);
  });

  it('gives no days for no rows', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('valueSpread', () => {
  it.each([
    ['no values', [], null],
    ['one value', [0.2], { min: 0.2, median: 0.2, max: 0.2 }],
    ['an odd count', [0.9, 0.1, 0.5], { min: 0.1, median: 0.5, max: 0.9 }],
    [
      'an even count (mean of the middle two)',
      [0.4, 0.1, 0.3, 0.2],
      { min: 0.1, median: 0.25, max: 0.4 },
    ],
  ])('%s', (_label, values, expected) => {
    expect(valueSpread(values)).toEqual(expected);
  });

  it('does not reorder its input', () => {
    const values = [0.9, 0.1, 0.5];
    valueSpread(values);
    expect(values).toEqual([0.9, 0.1, 0.5]);
  });
});

const plan = (id, outcome, next = null) => ({
  id,
  outcome,
  next,
  old: '1',
  spot: 620,
  scaledSpot: 155,
  low: 150,
  high: 160,
});

describe('pickSamples', () => {
  it('takes the repaired rows with the lowest and highest id, by number', () => {
    const plans = [
      plan('9', 'repaired', 0.5),
      plan('100', 'repaired', 0.6),
      plan('20', 'repaired', 0.7),
      plan('5', 'blanked'),
      plan('7', 'notArtifact'),
    ];
    expect(pickSamples(plans).map((p) => p.id)).toEqual(['9', '100']);
  });

  it('gives one sample when only one row was repaired', () => {
    expect(
      pickSamples([plan('9', 'repaired', 0.5), plan('5', 'blanked')]).map(
        (p) => p.id,
      ),
    ).toEqual(['9']);
  });

  it('falls back to blanked rows when nothing was repaired', () => {
    expect(
      pickSamples([plan('3', 'blanked'), plan('1', 'blanked')]).map(
        (p) => p.id,
      ),
    ).toEqual(['1', '3']);
  });

  it('gives none when every row was left alone', () => {
    expect(pickSamples([plan('3', 'notArtifact')])).toEqual([]);
  });
});

describe('writableRows', () => {
  it('lists repaired and blanked rows only, with the value as text and a blank as null', () => {
    const rows = writableRows([
      plan('1', 'repaired', 0.7125),
      plan('2', 'blanked'),
      plan('3', 'notArtifact'),
    ]);
    expect(rows).toEqual([
      { id: '1', next: '0.7125', old: '1' },
      { id: '2', next: null, old: '1' },
    ]);
  });
});

describe('summarizeTicker', () => {
  const plans = [
    plan('1', 'repaired', 0.25),
    plan('2', 'repaired', 0.75),
    plan('3', 'blanked'),
    plan('4', 'notArtifact'),
  ];

  it('counts each case and takes the spread over the repaired values only', () => {
    const s = summarizeTicker({
      ticker: 'CRWD',
      rowCount: 6,
      plans,
      failed: 2,
      written: 3,
      changedSinceRead: 0,
    });
    expect(s).toMatchObject({
      ticker: 'CRWD',
      rows: 6,
      repaired: 2,
      blanked: 1,
      notArtifact: 1,
      failed: 2,
      written: 3,
      changedSinceRead: 0,
      newValues: { min: 0.25, median: 0.5, max: 0.75 },
    });
    expect(s.samples.map((p) => p.id)).toEqual(['1', '2']);
  });

  it('refuses a tally whose cases do not add up to the rows', () => {
    expect(() =>
      summarizeTicker({
        ticker: 'CRWD',
        rowCount: 7,
        plans,
        failed: 2,
        written: 3,
        changedSinceRead: 0,
      }),
    ).toThrow(/CRWD: 7 rows but 6 accounted for/);
  });
});

describe('report lines', () => {
  const summary = summarizeTicker({
    ticker: 'CRWD',
    rowCount: 3,
    plans: [
      planRow(crwdRow(), CRWD_CANDLES, CRWD.spotScale),
      planRow(crwdRow({ id: '2', spot: 100_000 }), CRWD_CANDLES, 0.25),
      planRow(crwdRow({ id: '3', spot: 154.5 }), CRWD_CANDLES, 0.25),
    ],
    failed: 0,
    written: 2,
    changedSinceRead: 0,
  });

  it('prints the counts, the spread and the samples for the hand check', () => {
    const text = formatTickerReport(summary, CRWD, { apply: true }).join('\n');
    expect(text).toContain('CRWD');
    expect(text).toContain('rows 3');
    expect(text).toContain('repaired 1');
    expect(text).toContain('blanked 1');
    expect(text).toContain('notArtifact 1');
    expect(text).toContain('written 2');
    expect(text).toContain('changed since read 0');
    expect(text).toMatch(/new values \(n=1\): min 0\.7119\d* · median/);
    expect(text).toContain('id 647842');
    expect(text).toContain('spot 620.49');
    expect(text).toContain('scaled 155.1225');
    expect(text).toContain('range 153.25 to 155.88');
    expect(text).toContain('old 1');
  });

  it('says "would write" on a dry run', () => {
    const text = formatTickerReport(summary, CRWD, { apply: false }).join('\n');
    expect(text).toContain('would write 2');
    expect(text).not.toContain('written 2');
  });

  it('says there are no new values when nothing was repaired', () => {
    const none = summarizeTicker({
      ticker: 'SOXS',
      rowCount: 1,
      plans: [],
      failed: 1,
      written: 0,
      changedSinceRead: 0,
    });
    expect(
      formatTickerReport(none, SOXS, { apply: false }).join('\n'),
    ).toContain('new values: none');
  });

  it('prints one line per ticker-day with its outcome counts', () => {
    const line = formatDayLine({
      ticker: 'CRWD',
      date: '2026-05-19',
      rows: [crwdRow(), crwdRow({ id: '2' })],
      plans: [plan('1', 'repaired', 0.5), plan('2', 'blanked')],
      failure: null,
    });
    expect(line).toBe(
      'CRWD 2026-05-19  rows 2 · repaired 1 · blanked 1 · notArtifact 0 · failed 0',
    );
  });

  it('flags a failed ticker-day with the UW status', () => {
    const line = formatDayLine({
      ticker: 'CRWD',
      date: '2026-05-19',
      rows: [crwdRow(), crwdRow({ id: '2' })],
      plans: [],
      failure: { status: 'http_503', detail: 'down' },
    });
    expect(line).toBe(
      'CRWD 2026-05-19  rows 2 · repaired 0 · blanked 0 · notArtifact 0 · failed 2 (UW http_503)',
    );
  });
});

describe('the backup document', () => {
  const rows = [crwdRow(), soxsRow()];
  const createdAt = new Date('2026-11-19T22:45:01.234Z');

  it('has the version, the time, the repair windows and one entry per selected row', () => {
    const doc = buildBackup({ rows, createdAt });
    expect(doc.version).toBe(BACKUP_VERSION);
    expect(doc.createdAt).toBe('2026-11-19T22:45:01.234Z');
    expect(doc.repairs).toEqual([
      { ticker: 'CRWD', from: '2026-05-18', to: '2026-07-01', spotScale: 0.25 },
      { ticker: 'SOXS', from: '2026-05-18', to: '2026-07-10', spotScale: 10 },
    ]);
    expect(doc.rows).toEqual([
      {
        id: '647842',
        ticker: 'CRWD',
        date: '2026-05-19',
        trigger_time_ct: CRWD_TRIGGER,
        spot: 620.49,
        old: '1',
      },
      {
        id: '844453',
        ticker: 'SOXS',
        date: '2026-07-10',
        trigger_time_ct: SOXS_TRIGGER,
        spot: 4.0701,
        old: '0',
      },
    ]);
  });

  it('keeps only the six fields of a row, even when the selection carries more', () => {
    const doc = buildBackup({
      rows: [{ ...crwdRow(), extra: 'x', plan: {} }],
      createdAt,
    });
    expect(Object.keys(doc.rows[0])).toEqual([
      'id',
      'ticker',
      'date',
      'trigger_time_ct',
      'spot',
      'old',
    ]);
  });

  it('round-trips through its own text and the read-back check', () => {
    const doc = buildBackup({ rows, createdAt });
    const text = JSON.stringify(doc, null, 2);
    expect(parseBackup(text)).toEqual(doc);
    expect(() => verifyBackupText(doc, text)).not.toThrow();
  });

  it('fails the read-back when a row is missing or changed', () => {
    const doc = buildBackup({ rows, createdAt });
    const truncated = buildBackup({ rows: rows.slice(0, 1), createdAt });
    expect(() => verifyBackupText(doc, JSON.stringify(truncated))).toThrow(
      /does not match/,
    );
    const altered = buildBackup({
      rows: [crwdRow({ old: '0.5' }), soxsRow()],
      createdAt,
    });
    expect(() => verifyBackupText(doc, JSON.stringify(altered))).toThrow(
      /does not match/,
    );
  });

  it('names the file by UTC stamp under docs/tmp/range-pos-split-repair', () => {
    expect(BACKUP_DIR).toBe('docs/tmp/range-pos-split-repair');
    expect(backupFileName(createdAt)).toBe('backup-20261119T224501Z.json');
    expect(backupPath(createdAt)).toBe(
      'docs/tmp/range-pos-split-repair/backup-20261119T224501Z.json',
    );
  });
});

describe('parseBackup', () => {
  const good = {
    version: BACKUP_VERSION,
    rows: [{ id: '5', ticker: 'CRWD', old: '0.5' }],
  };

  it('accepts a null old (a row that was blank)', () => {
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...good,
          rows: [{ id: '5', ticker: 'CRWD', old: null }],
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['not JSON', 'not json at all', /not valid JSON/],
    ['JSON null', 'null', /not a range_pos split-repair backup/],
    [
      'a different version',
      JSON.stringify({ ...good, version: 99 }),
      /not a range_pos split-repair backup/,
    ],
    [
      'no rows array',
      JSON.stringify({ version: BACKUP_VERSION }),
      /not a range_pos split-repair backup/,
    ],
    [
      'a non-numeric id',
      JSON.stringify({
        ...good,
        rows: [{ id: '5; DROP TABLE x', ticker: 'CRWD', old: '1' }],
      }),
      /row 0 is malformed/,
    ],
    [
      'a numeric id',
      JSON.stringify({
        ...good,
        rows: [{ id: 5, ticker: 'CRWD', old: '1' }],
      }),
      /row 0 is malformed/,
    ],
    [
      'an old that is not a number as text',
      JSON.stringify({
        ...good,
        rows: [{ id: '5', ticker: 'CRWD', old: 'abc' }],
      }),
      /row 0 is malformed/,
    ],
    [
      'a row with no ticker',
      JSON.stringify({ ...good, rows: [{ id: '5', old: '1' }] }),
      /row 0 is malformed/,
    ],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseBackup(text)).toThrow(message);
  });
});

describe('undoPlan', () => {
  const doc = {
    version: BACKUP_VERSION,
    rows: [
      { id: '1', ticker: 'CRWD', old: '1' },
      { id: '2', ticker: 'SOXS', old: '0' },
      { id: '3', ticker: 'AAPL', old: '0.5' },
      { id: '4', ticker: 'CRWD', old: null },
    ],
  };

  it('restores the listed rows whose ticker is in SPLIT_REPAIRS', () => {
    const { restore } = undoPlan(doc);
    expect(restore).toEqual([
      { id: '1', ticker: 'CRWD', old: '1' },
      { id: '2', ticker: 'SOXS', old: '0' },
      { id: '4', ticker: 'CRWD', old: null },
    ]);
  });

  it('rejects the ids of tickers outside SPLIT_REPAIRS and keeps them out of the restore list', () => {
    const { restore, rejected } = undoPlan(doc);
    expect(rejected).toEqual([{ id: '3', ticker: 'AAPL' }]);
    expect(restore.map((r) => r.id)).not.toContain('3');
  });

  it('plans nothing for an empty backup', () => {
    expect(undoPlan({ version: BACKUP_VERSION, rows: [] })).toEqual({
      restore: [],
      rejected: [],
    });
  });
});

describe('parseRepairArgs', () => {
  it('defaults to a dry run that refuses market hours', () => {
    expect(parseRepairArgs([])).toEqual({
      apply: false,
      undoPath: null,
      allowMarketHours: false,
    });
  });

  it('reads --apply and --allow-market-hours', () => {
    expect(parseRepairArgs(['--apply', '--allow-market-hours'])).toEqual({
      apply: true,
      undoPath: null,
      allowMarketHours: true,
    });
  });

  it('reads --undo with its path, alone (a dry run of the undo) or with --apply', () => {
    expect(parseRepairArgs(['--undo', 'docs/tmp/b.json'])).toMatchObject({
      undoPath: 'docs/tmp/b.json',
      apply: false,
    });
    expect(
      parseRepairArgs(['--undo', 'docs/tmp/b.json', '--apply']),
    ).toMatchObject({ undoPath: 'docs/tmp/b.json', apply: true });
  });

  it.each([
    ['--undo at the end', ['--undo']],
    ['--undo followed by a flag', ['--undo', '--apply']],
    ['--undo followed by an empty path', ['--undo', '']],
  ])('rejects %s: it needs the path of a backup file', (_label, argv) => {
    expect(() => parseRepairArgs(argv)).toThrow(
      /--undo needs the path of a backup file/,
    );
  });

  it.each([['--bogus'], ['--dry-run'], ['--from'], ['backup.json']])(
    'rejects the unknown argument %s',
    (flag) => {
      expect(() => parseRepairArgs([flag])).toThrow(
        `Unknown argument: ${flag}`,
      );
    },
  );
});

describe('chunking at 500', () => {
  it('writes in the shared 500-row batch', () => {
    expect(WRITE_BATCH).toBe(500);
    const rows = Array.from({ length: 1_001 }, (_, i) => ({ id: String(i) }));
    expect(chunk(rows, WRITE_BATCH).map((c) => c.length)).toEqual([
      500, 500, 1,
    ]);
  });
});
