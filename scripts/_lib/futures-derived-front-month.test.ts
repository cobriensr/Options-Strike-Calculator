// @vitest-environment node

/**
 * Unit tests for `--repair front-month` of the derived-store recompute (Phase 6b
 * of docs/superpowers/specs/2026-11-06-futures-session-front-month.md): fills in
 * the attribution, the profile and its backup reader. How the profile changes the
 * recompute (arguments, scope, control set-aside) is in
 * futures-derived-front-month-run.test.ts, and everything that touches SQL runs
 * against pglite in futures-derived-front-month-pglite.test.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/_lib/db.js')>();
  return {
    ...actual,
    getDb: vi.fn(() => {
      throw new Error('getDb must not be reached');
    }),
  };
});

import {
  affectedSnapshotFields,
  attributeByValue,
  buildPreSeries,
  buildRepair,
  preRepairWindow,
  windowAffected,
  type BackupBar,
  type Bar,
} from './futures-derived-attribution.js';
import {
  FRONT_MONTH,
  frontMonthBackupLine,
  readFrontMonthBackup,
  type FrontMonthProfile,
} from './futures-derived-front-month.js';
import { SNAPSHOT_LOOKBACK_MS } from './futures-derived-recompute.js';
import { THIN_LAST_BAD_MS } from './futures-thin-roots.js';

const ms = (iso: string): number => Date.parse(iso);

const bar = (
  ts: string,
  close: number,
  volume = 100,
  over: Partial<Bar> = {},
): Bar => ({
  tsMs: ms(ts),
  high: close,
  low: close,
  close,
  volume,
  ...over,
});

const backupBar = (
  ts: string,
  op: BackupBar['op'],
  close: number,
  volume = 100,
  over: Partial<BackupBar> = {},
): BackupBar => ({
  op,
  symbol: 'ES',
  tsMs: ms(ts),
  high: close,
  low: close,
  close,
  volume,
  ...over,
});

const currentOf = (bars: Bar[]): Map<number, Bar> =>
  new Map(bars.map((b) => [b.tsMs, b]));

// ── Fills in the attribution ────────────────────────────────────────────────

describe('a fill in buildRepair', () => {
  const T = (m: number) => `2026-08-06T14:${String(m).padStart(2, '0')}:00Z`;

  it('is a new input bar: its close, volume and window are touched, and nothing is deleted', () => {
    const repair = buildRepair(
      [backupBar(T(30), 'fill', 7005)],
      // The filled bar is in the table, with the values the fill wrote.
      currentOf([bar(T(30), 7005)]),
    );
    expect(repair.deleted).toEqual([]);
    expect([...repair.closeChanged]).toEqual([ms(T(30))]);
    expect(repair.volumeTouched).toEqual([ms(T(30))]);
    expect(repair.windowTouched).toEqual([ms(T(30))]);
  });

  it('counts a fill whose bar is gone again as touched, not deleted', () => {
    const repair = buildRepair([backupBar(T(30), 'fill', 7005)], new Map());
    expect(repair.deleted).toEqual([]);
    expect([...repair.closeChanged]).toEqual([ms(T(30))]);
    expect(repair.volumeTouched).toEqual([ms(T(30))]);
  });

  it('keeps rewrites, deletes and fills of one series apart, each sorted', () => {
    const repair = buildRepair(
      [
        backupBar(T(40), 'fill', 7005),
        backupBar(T(10), 'update', 7000, 100), // close changed now
        backupBar(T(20), 'delete', 7000),
      ],
      currentOf([bar(T(10), 7010), bar(T(40), 7005)]),
    );
    expect(repair.deleted).toEqual([ms(T(20))]);
    expect([...repair.closeChanged].sort()).toEqual([ms(T(10)), ms(T(40))]);
    expect(repair.windowTouched).toEqual([ms(T(10)), ms(T(20)), ms(T(40))]);
  });
});

describe('a fill in the bars as they were before the repair', () => {
  const T = (m: number) => `2026-08-06T14:${String(m).padStart(2, '0')}:00Z`;

  it('buildPreSeries leaves the filled bar out and puts the rewritten close back', () => {
    const series = buildPreSeries(
      [
        backupBar(T(30), 'fill', 7005),
        backupBar(T(10), 'update', 7000),
        backupBar(T(20), 'delete', 7001),
      ],
      [bar(T(10), 7010), bar(T(30), 7005), bar(T(35), 7006)],
    );
    expect(series.map((b) => [b.tsMs, b.closePre, b.repair])).toEqual([
      [ms(T(10)), 7000, 'close-changed'],
      [ms(T(20)), 7001, 'deleted'],
      [ms(T(35)), 7006, null],
    ]);
  });

  it('a stored price that equals a filled bar finds no bar by value', () => {
    const series = buildPreSeries(
      [backupBar(T(30), 'fill', 7005)],
      [bar(T(20), 7000), bar(T(30), 7005)],
    );
    const rule = attributeByValue(series, ms(T(40)), null, {
      price: 7005,
      change1hPct: null,
      changeDayPct: null,
    });
    expect(rule.priceBar).toBeNull();
    expect(rule.unmatched).toEqual(['price']);
  });

  it('preRepairWindow takes the filled bar out of the window and leaves one outside it alone', () => {
    const from = ms('2026-08-05T22:00:00Z');
    const to = ms('2026-08-06T13:30:00Z');
    const now = [
      bar('2026-08-05T23:00:00Z', 7200, 100),
      bar('2026-08-06T03:00:00Z', 7205, 300),
      bar('2026-08-06T13:30:00Z', 7300, 50), // at the window end: not in it
    ];
    const before = preRepairWindow(
      now,
      [
        backupBar('2026-08-06T03:00:00Z', 'fill', 7205, 300),
        backupBar('2026-08-06T13:30:00Z', 'fill', 7300, 50),
        backupBar('2026-08-05T23:00:00Z', 'update', 7260, 100, { high: 7300 }),
      ],
      from,
      to,
    );
    expect(before.map((b) => [b.tsMs, b.close, b.high])).toEqual([
      [ms('2026-08-05T23:00:00Z'), 7260, 7300],
      [ms('2026-08-06T13:30:00Z'), 7300, 7300],
    ]);
  });

  it('a window with a fill inside it is affected, one without is not', () => {
    const repair = buildRepair(
      [backupBar('2026-08-06T03:00:00Z', 'fill', 7205)],
      currentOf([bar('2026-08-06T03:00:00Z', 7205)]),
    );
    expect(
      windowAffected(
        repair,
        ms('2026-08-05T22:00:00Z'),
        ms('2026-08-06T13:30:00Z'),
      ),
    ).toBe(true);
    expect(
      windowAffected(
        repair,
        ms('2026-08-06T04:00:00Z'),
        ms('2026-08-06T13:30:00Z'),
      ),
    ).toBe(false);
  });
});

describe('affectedSnapshotFields with a fill', () => {
  // 2026-08-06 is EDT: the open is 13:30Z. AT is 14:31:30, so the last closed bar
  // is 14:30, the hour-ago bar is the last one at or before 13:31:30.
  const AT = ms('2026-08-06T14:31:30Z');
  const OPEN = ms('2026-08-06T13:30:00Z');
  const bars = [
    bar('2026-07-30T15:00:00Z', 6990),
    bar('2026-08-06T13:30:00Z', 7000),
    bar('2026-08-06T13:31:00Z', 7001),
    bar('2026-08-06T14:20:00Z', 7003),
    bar('2026-08-06T14:30:00Z', 7005),
    bar('2026-08-06T14:31:00Z', 7099),
  ];
  const fieldsOf = (...fills: string[]): string[] => {
    const repair = buildRepair(
      fills.map((ts) => backupBar(ts, 'fill', 7000)),
      currentOf(bars),
    );
    return [...affectedSnapshotFields(repair, bars, AT, OPEN)].sort();
  };

  it.each([
    ['no fill', [], []],
    [
      'the latest closed bar',
      ['2026-08-06T14:30:00Z'],
      ['change1hPct', 'changeDayPct', 'price', 'volumeRatio'],
    ],
    [
      'the hour-ago bar',
      ['2026-08-06T13:31:00Z'],
      ['change1hPct', 'volumeRatio'],
    ],
    [
      'the day-open bar',
      ['2026-08-06T13:30:00Z'],
      ['changeDayPct', 'volumeRatio'],
    ],
    [
      'a bar in the 20-day window that no input reads',
      ['2026-08-06T14:20:00Z'],
      ['volumeRatio'],
    ],
    [
      'a bar older than latest, hour-ago and open, inside the window',
      ['2026-07-30T15:00:00Z'],
      ['volumeRatio'],
    ],
    [
      'a bar 21 days before the row, outside the volume window',
      ['2026-07-15T15:00:00Z'],
      [],
    ],
    [
      'the bar of the open minute, not closed yet',
      ['2026-08-06T14:31:00Z'],
      [],
    ],
  ])('%s', (_name, fills, expected) => {
    expect(fieldsOf(...fills)).toEqual(expected);
  });
});

// ── The profile ─────────────────────────────────────────────────────────────

describe('the front-month profile', () => {
  it('pins the span, the end of the write run, the backup and its totals', () => {
    expect(new Date(FRONT_MONTH.span.startMs).toISOString()).toBe(
      '2026-07-28T00:00:00.000Z',
    );
    expect(new Date(FRONT_MONTH.span.endMs).toISOString()).toBe(
      '2026-11-12T00:00:00.000Z',
    );
    expect(new Date(FRONT_MONTH.writtenUntilMs).toISOString()).toBe(
      '2026-11-13T05:16:00.000Z',
    );
    expect(FRONT_MONTH.backup).toEqual({
      runId: '2026-11-13T05-10-59Z',
      totals: { rewrite: 9411, delete: 194, fill: 79802, tag: 536310 },
    });
    expect(FRONT_MONTH.defaultWorkDir).toBe(
      'docs/tmp/futures-derived-recompute-front-month',
    );
  });

  it('starts more than 20 days after every thin root`s last bad bar, so the D1 lift has nothing to lift', () => {
    // The profile skips the D1 lift. Its premise: the 20-day window of the
    // first row in the span begins after the last month-mixed bar of April to June.
    const lastBad = Math.max(...Object.values(THIN_LAST_BAD_MS));
    expect(FRONT_MONTH.span.startMs - SNAPSHOT_LOOKBACK_MS).toBeGreaterThan(
      lastBad,
    );
  });

  it('ends the write run after the span and before the span end + 20 days, so the snapshot scope clamps to it', () => {
    expect(FRONT_MONTH.writtenUntilMs).toBeGreaterThan(FRONT_MONTH.span.endMs);
    expect(FRONT_MONTH.writtenUntilMs).toBeLessThan(
      FRONT_MONTH.span.endMs + SNAPSHOT_LOOKBACK_MS,
    );
  });
});

// ── The backup reader ───────────────────────────────────────────────────────

describe('readFrontMonthBackup', () => {
  const RUN = 'run-1';
  const profile = (
    totals = { rewrite: 1, delete: 1, fill: 1, tag: 1 },
    over: Partial<FrontMonthProfile['backup']> = {},
  ): Pick<FrontMonthProfile, 'span' | 'backup'> => ({
    span: {
      startMs: ms('2026-07-28T00:00:00Z'),
      endMs: ms('2026-11-12T00:00:00Z'),
    },
    backup: { runId: RUN, totals, ...over },
  });

  const row = (ts: string, close: string, volume = 7, over = {}) => ({
    ts,
    open: close,
    high: close,
    low: close,
    close,
    volume,
    buyVolume: null,
    sellVolume: null,
    buyPrints: null,
    sellPrints: null,
    contract: null,
    ...over,
  });
  const lines = {
    rewrite: (symbol = 'ES', ts = '2026-09-14T14:30:00.000Z') => ({
      runId: RUN,
      action: 'rewrite',
      symbol,
      row: row(ts, '7100.2500', 9, { open: '7099.0000', high: '7101.5000' }),
      after: row(ts, '7007', 12, { contract: 'ESZ6' }),
    }),
    delete: (symbol = 'CL', ts = '2026-10-16T14:29:00.000Z') => ({
      runId: RUN,
      action: 'delete',
      symbol,
      row: row(ts, '85.3300', 1),
    }),
    fill: (symbol = 'GC', ts = '2026-07-28T00:00:00.000Z') => ({
      runId: RUN,
      action: 'fill',
      symbol,
      after: row(ts, '4073.0', 46, { open: '4074.4', high: '4075.5' }),
    }),
    tag: (symbol = 'RTY', ts = '2026-07-28T00:00:00.000Z') => ({
      runId: RUN,
      action: 'tag',
      symbol,
      row: row(ts, '2959.0000', 32),
      after: { contract: 'RTYU6' },
    }),
  };
  const GOOD = [lines.rewrite(), lines.delete(), lines.fill(), lines.tag()];

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'front-month-unit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (content: readonly (object | string)[], eol = '\n'): string => {
    const path = join(dir, 'backup.jsonl');
    writeFileSync(
      path,
      content
        .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
        .join(eol) + eol,
    );
    return path;
  };

  it('reads a rewrite as an update with the old values, a delete, and a fill from its after bar; a tag is only counted', async () => {
    const path = write(GOOD);
    const read = await readFrontMonthBackup(path, profile());
    expect(read.counts).toEqual({ rewrite: 1, delete: 1, fill: 1, tag: 1 });
    expect(read.bars).toEqual([
      {
        op: 'update',
        symbol: 'ES',
        tsMs: ms('2026-09-14T14:30:00Z'),
        open: 7099,
        high: 7101.5,
        low: 7100.25,
        close: 7100.25,
        volume: 9,
      },
      {
        op: 'delete',
        symbol: 'CL',
        tsMs: ms('2026-10-16T14:29:00Z'),
        open: 85.33,
        high: 85.33,
        low: 85.33,
        close: 85.33,
        volume: 1,
      },
      {
        op: 'fill',
        symbol: 'GC',
        tsMs: ms('2026-07-28T00:00:00Z'),
        open: 4074.4,
        high: 4075.5,
        low: 4073,
        close: 4073,
        volume: 46,
      },
    ]);
  });

  it('reads CRLF files and skips blank lines', async () => {
    const read = await readFrontMonthBackup(
      write(
        [GOOD[0] ?? '', '', GOOD[1] ?? '', GOOD[2] ?? '', GOOD[3] ?? ''],
        '\r\n',
      ),
      profile(),
    );
    expect(read.bars).toHaveLength(3);
  });

  it('reads the last line when the file has no final newline', async () => {
    const path = join(dir, 'backup.jsonl');
    writeFileSync(path, GOOD.map((l) => JSON.stringify(l)).join('\n'));
    const read = await readFrontMonthBackup(path, profile());
    expect(read.counts.tag).toBe(1);
  });

  it('reads a file larger than one stream chunk, a line cut anywhere', async () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      lines.fill(
        'ES',
        new Date(ms('2026-08-01T00:00:00Z') + i * 60_000).toISOString(),
      ),
    );
    const read = await readFrontMonthBackup(
      write(many),
      profile({ rewrite: 0, delete: 0, fill: 2000, tag: 0 }),
    );
    expect(read.bars).toHaveLength(2000);
    expect(read.bars.at(-1)?.tsMs).toBe(ms('2026-08-02T09:19:00Z'));
  });

  describe('refuses, naming the file and the line', () => {
    const refusals: [string, (string | object)[], RegExp][] = [
      [
        'another run id',
        [GOOD[0] ?? '', { ...lines.delete(), runId: 'run-0' }],
        /backup\.jsonl:2: runId "run-0" is not "run-1"/,
      ],
      [
        'an unknown action',
        [GOOD[0] ?? '', { ...lines.delete(), action: 'merge' }],
        /backup\.jsonl:2: unknown action "merge"/,
      ],
      [
        'no action',
        [GOOD[0] ?? '', { runId: RUN, symbol: 'ES' }],
        /backup\.jsonl:2: unknown action "undefined"/,
      ],
      [
        'an unknown symbol',
        [GOOD[0] ?? '', lines.delete('DX')],
        /backup\.jsonl:2: unknown symbol "DX"/,
      ],
      [
        'a rewrite before the span',
        [lines.rewrite('ES', '2026-07-27T23:59:00.000Z')],
        /backup\.jsonl:1: ts 2026-07-27T23:59:00.000Z is outside the span 2026-07-28T00:00:00Z \.\. 2026-11-12T00:00:00Z/,
      ],
      [
        'a delete at the span end',
        [GOOD[0] ?? '', lines.delete('CL', '2026-11-12T00:00:00.000Z')],
        /backup\.jsonl:2: ts 2026-11-12T00:00:00.000Z is outside the span/,
      ],
      [
        'a fill after the span',
        [lines.fill('GC', '2026-11-12T00:01:00.000Z')],
        /backup\.jsonl:1: ts 2026-11-12T00:01:00.000Z is outside the span/,
      ],
      [
        'a rewrite whose after bar is another minute',
        [
          {
            ...lines.rewrite(),
            after: row('2026-09-14T14:31:00.000Z', '7007'),
          },
        ],
        /backup\.jsonl:1: the after bar is 2026-09-14T14:31:00.000Z, the row 2026-09-14T14:30:00.000Z/,
      ],
      [
        'the same bar twice',
        [GOOD[0] ?? '', GOOD[1] ?? '', lines.rewrite()],
        /backup\.jsonl:3: ES 2026-09-14T14:30:00.000Z is listed again \(first at line 1\)/,
      ],
      [
        'a tag on a minute that has a fill',
        [lines.fill('RTY'), lines.tag('RTY')],
        /backup\.jsonl:2: RTY 2026-07-28T00:00:00.000Z is listed again \(first at line 1\)/,
      ],
      [
        'a line that is not JSON',
        [GOOD[0] ?? '', '{not json'],
        /backup\.jsonl:2: not JSON/,
      ],
      [
        'a line that is not an object',
        [GOOD[0] ?? '', '[1,2]'],
        /backup\.jsonl:2: is not an object/,
      ],
      [
        'a price that is not a number',
        [{ ...lines.delete(), row: row('2026-10-16T14:29:00.000Z', 'x') }],
        /backup\.jsonl:1: row\.open not a number/,
      ],
      [
        'a volume that is text',
        [
          {
            ...lines.delete(),
            row: row('2026-10-16T14:29:00.000Z', '85.33', '1' as never),
          },
        ],
        /backup\.jsonl:1: row\.volume/,
      ],
      [
        'a ts that is not a date',
        [{ ...lines.delete(), row: row('yesterday', '85.33') }],
        /backup\.jsonl:1: ts "yesterday" is not a date/,
      ],
      [
        'a fill with no after bar',
        [{ runId: RUN, action: 'fill', symbol: 'GC' }],
        /backup\.jsonl:1: after/,
      ],
    ];
    it.each(refusals)('%s', async (_name, content, message) => {
      await expect(
        readFrontMonthBackup(write(content), profile()),
      ).rejects.toThrow(message);
    });

    it('a rewrite, delete, fill or tag count that differs from the pin', async () => {
      const path = write(GOOD);
      await expect(
        readFrontMonthBackup(
          path,
          profile({ rewrite: 2, delete: 1, fill: 1, tag: 1 }),
        ),
      ).rejects.toThrow(
        /backup\.jsonl: the totals are not the pinned ones: rewrite 1 \(pinned 2\)/,
      );
      await expect(
        readFrontMonthBackup(
          path,
          profile({ rewrite: 1, delete: 1, fill: 1, tag: 536310 }),
        ),
      ).rejects.toThrow(/tag 1 \(pinned 536310\)/);
    });

    it('a file that is cut short, which has fewer lines than the pinned totals', async () => {
      const path = write(GOOD.slice(0, 2));
      await expect(readFrontMonthBackup(path, profile())).rejects.toThrow(
        /fill 0 \(pinned 1\), tag 0 \(pinned 1\)/,
      );
    });

    it('a file that does not exist', async () => {
      await expect(
        readFrontMonthBackup(join(dir, 'missing.jsonl'), profile()),
      ).rejects.toThrow(/ENOENT/);
    });
  });
});

// ── The report line ─────────────────────────────────────────────────────────

describe('frontMonthBackupLine', () => {
  it('counts rewrites, deletes and fills apart, per root, and says what the skipped tags are', () => {
    const bars: BackupBar[] = [
      backupBar('2026-09-14T14:30:00Z', 'update', 7100),
      backupBar('2026-09-14T14:31:00Z', 'update', 7100),
      backupBar('2026-09-14T14:32:00Z', 'delete', 7100),
      { ...backupBar('2026-08-06T13:30:00Z', 'fill', 7000), symbol: 'NQ' },
      { ...backupBar('2026-08-06T13:31:00Z', 'fill', 7000), symbol: 'NQ' },
      { ...backupBar('2026-08-06T13:32:00Z', 'fill', 7000), symbol: 'NQ' },
    ];
    expect(
      frontMonthBackupLine(
        'b.jsonl',
        { bars, counts: { rewrite: 2, delete: 1, fill: 3, tag: 40 } },
        ['ES', 'NQ'],
      ),
    ).toBe(
      'bar backup b.jsonl: 46 lines (rewrites 2, deletes 1, fills 3, tags 40 skipped: a tag changes no value); ' +
        'rewritten by root: ES 2, NQ 0; deleted by root: ES 1, NQ 0; filled by root: ES 0, NQ 3',
    );
  });
});
