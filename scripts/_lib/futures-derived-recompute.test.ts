// @vitest-environment node

/**
 * Unit tests for the Phase 4 recompute tool: argument parsing, the scope
 * ranges, the control-set rules, the apply gate, the PCS gate-flip list and the
 * market-hours refusal. Everything that touches SQL runs against pglite in
 * futures-derived-recompute-pglite.test.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Globex } from '../../api/cron/auto-prefill-premarket.js';
import type { SnapshotResult } from '../../api/_lib/futures-derive.js';

vi.mock('../../api/_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/_lib/db.js')>();
  return {
    ...actual,
    getDb: vi.fn(() => {
      throw new Error('getDb must not be reached');
    }),
  };
});

import { getDb } from '../../api/_lib/db.js';
import {
  BASIS_LOOKBACK_MS,
  SNAPSHOT_LOOKBACK_MS,
  SPAN,
  BARS_LEAD_MS,
  STALE_UNTIL_MS,
  checkApplyGate,
  checkJunkGate,
  checkStaleGate,
  compareGlobex,
  compareSnapshot,
  ctTradingDay,
  frozenRunsOf,
  gateFlips,
  parseDetectorDays,
  parseRecomputeArgs,
  pcsPasses,
  premarketInScope,
  premarketWindow,
  readOnlyFetch,
  roundNumeric,
  runRecompute,
  scopeRanges,
  snapshotProblems,
  volumeRatioWriteText,
  type SnapshotChange,
  type Control,
  type FireChange,
  type SnapshotValues,
} from './futures-derived-recompute.js';
import {
  affectedSnapshotFields,
  aggregateWindow,
  attributeByValue,
  buildPreSeries,
  buildRepair,
  classifyMismatch,
  classifyThinMiss,
  findMergeState,
  inputsMatchSnapshot,
  mergeStateBars,
  parseBackup,
  preRepairWindow,
  snapshotInputs,
  windowAffected,
  type BackupBar,
  type Bar,
  type MergeBarView,
  type PreBar,
  type Repair,
  VALUE_LOOKBACK_MS,
} from './futures-derived-attribution.js';

const ms = (iso: string): number => Date.parse(iso);

// ── Arguments ───────────────────────────────────────────────────────────────

describe('parseRecomputeArgs', () => {
  it('defaults to a dry run over all three stores', () => {
    expect(parseRecomputeArgs(['--backup', 'b.jsonl'])).toEqual({
      workDir: 'docs/tmp/futures-derived-recompute',
      apply: false,
      force: false,
      stores: ['snapshots', 'premarket', 'fires'],
      backup: 'b.jsonl',
      expectSnapshots: null,
      expectPremarket: null,
      expectFires: null,
      deleteJunkStale: false,
      expectJunkDeletes: null,
      rewriteStaleAtWrite: false,
      expectStaleRewrites: null,
      detectorDays: null,
      envFile: null,
    });
  });

  it('parses a full --apply', () => {
    expect(
      parseRecomputeArgs([
        '--apply',
        '--expect-snapshots',
        '31012',
        '--expect-premarket',
        '36',
        '--expect-fires',
        '240',
        '--work-dir',
        'out',
        '--backup',
        'backup.jsonl',
        '--env-file',
        '.env.test',
        '--force',
      ]),
    ).toEqual({
      workDir: 'out',
      apply: true,
      force: true,
      stores: ['snapshots', 'premarket', 'fires'],
      backup: 'backup.jsonl',
      expectSnapshots: 31012,
      expectPremarket: 36,
      expectFires: 240,
      deleteJunkStale: false,
      expectJunkDeletes: null,
      rewriteStaleAtWrite: false,
      expectStaleRewrites: null,
      detectorDays: null,
      envFile: '.env.test',
    });
  });

  it('takes --detector-days with a path, in a dry run too, and refuses it without one', () => {
    expect(
      parseRecomputeArgs([
        '--backup',
        'b.jsonl',
        '--detector-days',
        'detector_days.json',
      ]).detectorDays,
    ).toBe('detector_days.json');
    expect(() =>
      parseRecomputeArgs(['--backup', 'b.jsonl', '--detector-days']),
    ).toThrow('--detector-days needs a value');
  });

  it('takes --rewrite-stale-at-write with its count, under --apply only', () => {
    const args = parseRecomputeArgs([
      '--apply',
      '--backup',
      'b.jsonl',
      '--expect-snapshots',
      '10',
      '--expect-premarket',
      '1',
      '--expect-fires',
      '2',
      '--rewrite-stale-at-write',
      '--expect-stale-rewrites',
      '4321',
    ]);
    expect(args.rewriteStaleAtWrite).toBe(true);
    expect(args.expectStaleRewrites).toBe(4321);
  });

  it('takes --delete-junk-stale with its count, under --apply only', () => {
    const args = parseRecomputeArgs([
      '--apply',
      '--backup',
      'b.jsonl',
      '--expect-snapshots',
      '10',
      '--expect-premarket',
      '1',
      '--expect-fires',
      '2',
      '--delete-junk-stale',
      '--expect-junk-deletes',
      '1964',
    ]);
    expect(args.deleteJunkStale).toBe(true);
    expect(args.expectJunkDeletes).toBe(1964);
  });

  it('asks only for the expectations of the stores it was given', () => {
    const args = parseRecomputeArgs([
      '--apply',
      '--backup',
      'b.jsonl',
      '--stores',
      'fires',
      '--expect-fires',
      '12',
    ]);
    expect(args.stores).toEqual(['fires']);
    expect(args.expectFires).toBe(12);
    expect(args.expectSnapshots).toBeNull();
    expect(() =>
      parseRecomputeArgs(['--apply', '--stores', 'fires', 'premarket']),
    ).toThrow(/--apply needs --expect-fires K and --expect-premarket M/);
  });

  it('asks for the Phase 2 backup when a store needs the bars, and always with --apply', () => {
    const needs =
      /--backup <file> is required with --apply or with the snapshots or premarket store/;
    expect(() => parseRecomputeArgs([])).toThrow(needs);
    expect(() => parseRecomputeArgs(['--stores', 'premarket'])).toThrow(needs);
    // --apply plans all three stores to check them, so even a fires-only
    // apply needs the backup the snapshot and pre-market checks read.
    expect(() =>
      parseRecomputeArgs([
        '--apply',
        '--stores',
        'fires',
        '--expect-fires',
        '1',
      ]),
    ).toThrow(needs);
    expect(parseRecomputeArgs(['--stores', 'fires']).stores).toEqual(['fires']);
  });

  it.each([
    [['--bogus'], /unknown argument --bogus/],
    [['--work-dir'], /--work-dir needs a value/],
    [['--env-file'], /--env-file needs a value/],
    [['--stores'], /--stores needs a value/],
    [['--stores', '--apply'], /--stores needs a value/],
    [['--stores', 'bars'], /unknown store "bars"/],
    [['--backup'], /--backup needs a value/],
    [['--force'], /--force only applies with --apply/],
    [
      ['--apply'],
      /--apply needs --expect-snapshots N and --expect-premarket M and --expect-fires K/,
    ],
    [
      ['--apply', '--expect-snapshots', '1', '--expect-premarket', '1'],
      /--apply needs --expect-fires K/,
    ],
    [
      ['--expect-snapshots', '1'],
      /--expect-snapshots only applies with --apply/,
    ],
    [['--expect-fires', '1'], /--expect-fires only applies with --apply/],
    [
      ['--apply', '--expect-snapshots', 'many'],
      /--expect-snapshots needs a whole number, got "many"/,
    ],
    [
      ['--apply', '--expect-premarket', '-1'],
      /--expect-premarket needs a whole number, got "-1"/,
    ],
    [
      ['--apply', '--expect-fires', '1.5'],
      /--expect-fires needs a whole number, got "1.5"/,
    ],
    // The stale-at-write rewrite is opt-in, counted, and a snapshots write.
    [
      ['--rewrite-stale-at-write'],
      /--rewrite-stale-at-write only applies with --apply/,
    ],
    [
      ['--expect-stale-rewrites', '3'],
      /--expect-stale-rewrites only applies with --apply/,
    ],
    [
      [
        '--apply',
        '--backup',
        'b.jsonl',
        '--stores',
        'fires',
        '--expect-fires',
        '1',
        '--expect-stale-rewrites',
        '3',
      ],
      /--expect-stale-rewrites needs --rewrite-stale-at-write/,
    ],
    [
      [
        '--apply',
        '--backup',
        'b.jsonl',
        '--expect-snapshots',
        '1',
        '--expect-premarket',
        '1',
        '--expect-fires',
        '1',
        '--rewrite-stale-at-write',
      ],
      /--rewrite-stale-at-write needs --expect-stale-rewrites S: the count of the dry run you approved/,
    ],
    [
      [
        '--apply',
        '--backup',
        'b.jsonl',
        '--stores',
        'fires',
        '--expect-fires',
        '1',
        '--rewrite-stale-at-write',
        '--expect-stale-rewrites',
        '3',
      ],
      /--rewrite-stale-at-write writes futures_snapshots, so --stores must include snapshots/,
    ],
    [
      [
        '--apply',
        '--backup',
        'b.jsonl',
        '--stores',
        'snapshots',
        '--expect-snapshots',
        '1',
        '--rewrite-stale-at-write',
        '--expect-stale-rewrites',
        'many',
      ],
      /--expect-stale-rewrites needs a whole number, got "many"/,
    ],
    // The junk delete is opt-in, counted, and a snapshots write.
    [['--delete-junk-stale'], /--delete-junk-stale only applies with --apply/],
    [
      ['--expect-junk-deletes', '3'],
      /--expect-junk-deletes only applies with --apply/,
    ],
    [
      [
        '--apply',
        '--backup',
        'b.jsonl',
        '--stores',
        'fires',
        '--expect-fires',
        '1',
        '--expect-junk-deletes',
        '3',
      ],
      /--expect-junk-deletes needs --delete-junk-stale/,
    ],
    [
      [
        '--apply',
        '--backup',
        'b.jsonl',
        '--expect-snapshots',
        '1',
        '--expect-premarket',
        '1',
        '--expect-fires',
        '1',
        '--delete-junk-stale',
      ],
      /--delete-junk-stale needs --expect-junk-deletes J: the count of the dry run you approved/,
    ],
    [
      [
        '--apply',
        '--backup',
        'b.jsonl',
        '--stores',
        'fires',
        '--expect-fires',
        '1',
        '--delete-junk-stale',
        '--expect-junk-deletes',
        '3',
      ],
      /--delete-junk-stale deletes from futures_snapshots, so --stores must include snapshots/,
    ],
    [
      [
        '--apply',
        '--backup',
        'b.jsonl',
        '--stores',
        'snapshots',
        '--expect-snapshots',
        '1',
        '--delete-junk-stale',
        '--expect-junk-deletes',
        'all',
      ],
      /--expect-junk-deletes needs a whole number, got "all"/,
    ],
  ])('rejects %j', (argv, message) => {
    expect(() => parseRecomputeArgs(argv)).toThrow(message);
  });
});

// ── Scope ───────────────────────────────────────────────────────────────────

describe('checkJunkGate', () => {
  it('has nothing to say without the flag, whatever the count', () => {
    expect(
      checkJunkGate({ deleteJunkStale: false, expectJunkDeletes: null }, 7),
    ).toEqual([]);
    expect(
      checkJunkGate({ deleteJunkStale: false, expectJunkDeletes: 3 }, 7),
    ).toEqual([]);
  });

  it('passes the approved count, including zero', () => {
    expect(
      checkJunkGate({ deleteJunkStale: true, expectJunkDeletes: 7 }, 7),
    ).toEqual([]);
    expect(
      checkJunkGate({ deleteJunkStale: true, expectJunkDeletes: 0 }, 0),
    ).toEqual([]);
  });

  it('refuses a missing count and a different count, naming both', () => {
    expect(
      checkJunkGate({ deleteJunkStale: true, expectJunkDeletes: null }, 7),
    ).toEqual([
      '--delete-junk-stale needs --expect-junk-deletes J: the count of the dry run you approved',
    ]);
    expect(
      checkJunkGate({ deleteJunkStale: true, expectJunkDeletes: 6 }, 7),
    ).toEqual([
      'the fresh plan deletes 7 junk-priced rows, --expect-junk-deletes 6 was given',
    ]);
  });
});

describe('checkStaleGate', () => {
  it('has nothing to say without the flag, whatever the count', () => {
    expect(
      checkStaleGate(
        { rewriteStaleAtWrite: false, expectStaleRewrites: null },
        7,
      ),
    ).toEqual([]);
    expect(
      checkStaleGate({ rewriteStaleAtWrite: false, expectStaleRewrites: 3 }, 7),
    ).toEqual([]);
  });

  it('passes the approved count, including zero', () => {
    expect(
      checkStaleGate({ rewriteStaleAtWrite: true, expectStaleRewrites: 7 }, 7),
    ).toEqual([]);
    expect(
      checkStaleGate({ rewriteStaleAtWrite: true, expectStaleRewrites: 0 }, 0),
    ).toEqual([]);
  });

  it('refuses a missing count and a different count, naming both', () => {
    expect(
      checkStaleGate(
        { rewriteStaleAtWrite: true, expectStaleRewrites: null },
        7,
      ),
    ).toEqual([
      '--rewrite-stale-at-write needs --expect-stale-rewrites S: the count of the dry run you approved',
    ]);
    expect(
      checkStaleGate({ rewriteStaleAtWrite: true, expectStaleRewrites: 6 }, 7),
    ).toEqual([
      'the fresh plan rewrites 7 stale-at-write rows, --expect-stale-rewrites 6 was given',
    ]);
  });
});

describe('ctTradingDay', () => {
  // The Phase 1 detector's day (feat.py): the CT date of the time plus 7 hours,
  // so the Globex session that opens at 17:00 CT belongs to the next date.
  it.each([
    ['Sunday 17:00 CDT opens Monday', '2026-06-14T22:00:00Z', '2026-06-15'],
    ['Monday 15:59 CDT is still Monday', '2026-06-15T20:59:00Z', '2026-06-15'],
    [
      'Monday 16:30 CDT, in the break, is Monday',
      '2026-06-15T21:30:00Z',
      '2026-06-15',
    ],
    ['Monday 17:00 CDT opens Tuesday', '2026-06-15T22:00:00Z', '2026-06-16'],
    ['Sunday 17:00 CST opens Monday', '2026-11-08T23:00:00Z', '2026-11-09'],
  ])('%s', (_name, iso, day) => {
    expect(ctTradingDay(ms(iso))).toBe(day);
  });
});

describe('frozenRunsOf', () => {
  const MIN = 60_000;
  const at = (minutes: number, price: number) => ({
    tsMs: ms('2026-06-10T14:00:00Z') + minutes * MIN,
    stored: { price },
  });

  it('marks a run that spans more than the freshness gate, and only that run', () => {
    // 7000 for 20 minutes (5 rows), then 7001 for 15 minutes exactly, then 7002 alone.
    const rows = [
      ...[0, 5, 10, 15, 20].map((m) => at(m, 7000)),
      ...[25, 30, 35, 40].map((m) => at(m, 7001)),
      at(45, 7002),
    ];
    const runs = frozenRunsOf(rows);
    const first = { startMs: rows[0]!.tsMs, endMs: rows[4]!.tsMs, rows: 5 };
    expect(runs.slice(0, 5)).toEqual([first, first, first, first, first]);
    // 15 minutes from the first row to the last is not more than the gate.
    expect(runs.slice(5)).toEqual([null, null, null, null, null]);
  });

  it('breaks a run at a different price, and does not rejoin it after one', () => {
    const rows = [
      at(0, 7000),
      at(10, 7000),
      at(20, 7000),
      at(25, 7100),
      at(30, 7000),
      at(40, 7000),
    ];
    const runs = frozenRunsOf(rows);
    expect(runs.map((r) => r?.rows ?? null)).toEqual([
      3,
      3,
      3,
      null,
      null,
      null,
    ]);
  });

  it('handles no rows and one row', () => {
    expect(frozenRunsOf([])).toEqual([]);
    expect(frozenRunsOf([at(0, 7000)])).toEqual([null]);
  });
});

describe('parseDetectorDays', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    contaminated: [],
    flagged: ['2026-07-14'],
    ...over,
  });
  const file = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      RTY: entry(),
      CL: entry({ flagged: [] }),
      GC: entry({
        contaminated: ['2026-09-04'],
        flagged: ['2026-09-04', '2026-09-11'],
      }),
      ZN: entry({ flagged: ['2026-06-25'] }),
      ...over,
    });

  it('reads the contaminated and the flagged days of each thin root', () => {
    const days = parseDetectorDays(file(), 'f.json');
    expect([...days.keys()].sort()).toEqual(['CL', 'GC', 'RTY', 'ZN']);
    expect(days.get('RTY')?.contaminated).toEqual(new Set());
    expect(days.get('RTY')?.flagged).toEqual(new Set(['2026-07-14']));
    expect(days.get('CL')?.flagged).toEqual(new Set());
    expect(days.get('GC')?.contaminated.has('2026-09-04')).toBe(true);
    expect(days.get('GC')?.flagged.has('2026-09-11')).toBe(true);
  });

  const shape =
    'must list GC as {"contaminated": [...], "flagged": [...]} of YYYY-MM-DD days';
  it.each([
    ['text that is not JSON', 'nope', 'f.json is not JSON'],
    ['an array', '[]', 'f.json must be an object with a day list per root'],
    ['null', 'null', 'f.json must be an object with a day list per root'],
    [
      'a root that is not thin',
      file({ ES: entry() }),
      'f.json lists ES, which is not a thin root (ZN, RTY, CL, GC)',
    ],
    [
      'a thin root left out',
      JSON.stringify({ RTY: entry(), GC: entry(), ZN: entry() }),
      'f.json must list CL as {"contaminated": [...], "flagged": [...]} of YYYY-MM-DD days',
    ],
    [
      'a root that is a bare list',
      file({ GC: ['2026-09-04'] }),
      `f.json ${shape}`,
    ],
    [
      'a contaminated list that is missing',
      file({ GC: { flagged: [] } }),
      `f.json ${shape}`,
    ],
    [
      'a flagged list that is missing',
      file({ GC: { contaminated: [] } }),
      `f.json ${shape}`,
    ],
    [
      'a day that is not YYYY-MM-DD',
      file({ GC: entry({ flagged: ['2026-6-25'] }) }),
      `f.json ${shape}`,
    ],
    [
      'a day that is not a string',
      file({ GC: entry({ contaminated: [20260714] }) }),
      `f.json ${shape}`,
    ],
  ])('refuses %s', (_name, text, message) => {
    expect(() => parseDetectorDays(text, 'f.json')).toThrow(message);
  });
});

describe('scope', () => {
  it('reads snapshot rows up to 2026-10-01, the day after the freshness gate shipped, for the stale-at-write test', () => {
    expect(STALE_UNTIL_MS).toBe(ms('2026-10-01T00:00:00Z'));
    expect(STALE_UNTIL_MS).toBeGreaterThan(scopeRanges().snapshots.toMs);
  });

  it("reads bars as far back as the value rule looks, so the first row's look-back is covered", () => {
    expect(BARS_LEAD_MS).toBeGreaterThanOrEqual(VALUE_LOOKBACK_MS);
  });

  it('is the Phase 2 span, half-open', () => {
    expect(SPAN.startMs).toBe(ms('2026-04-05T22:00:00Z'));
    expect(SPAN.endMs).toBe(ms('2026-06-15T14:11:00Z'));
  });

  it('reaches snapshots 20 days past the span (the volume baseline) and fires 6 minutes (the basis window)', () => {
    expect(SNAPSHOT_LOOKBACK_MS).toBe(20 * 86_400_000);
    expect(BASIS_LOOKBACK_MS).toBe(6 * 60_000);
    const { snapshots, fires } = scopeRanges();
    expect(snapshots).toEqual({
      fromMs: ms('2026-04-05T22:00:00Z'),
      toMs: ms('2026-07-05T14:11:00Z'),
    });
    expect(fires).toEqual({
      fromMs: ms('2026-04-05T22:00:00Z'),
      toMs: ms('2026-06-15T14:17:00Z'),
    });
  });

  it.each([
    // Friday: window Thursday 22:00Z to Friday 13:30Z, wholly before the span.
    ['2026-04-03', false],
    // Monday: window starts Friday 22:00Z and ends 04-06 13:30Z, after the span starts.
    ['2026-04-06', true],
    ['2026-06-12', true],
    // Monday 06-15: window Friday 22:00Z to 13:30Z, before the span ends at 14:11Z.
    ['2026-06-15', true],
    // Tuesday: window starts 06-15 22:00Z, after the span ended.
    ['2026-06-16', false],
    ['2026-11-06', false],
  ])('premarketInScope(%s) is %s', (date, inScope) => {
    expect(premarketInScope(date)).toBe(inScope);
  });

  it('shares the cron window: Monday goes back to Friday 22:00Z, the end is the cash open', () => {
    expect(premarketWindow('2026-04-06')).toEqual({
      fromMs: ms('2026-04-03T22:00:00Z'),
      toMs: ms('2026-04-06T13:30:00Z'),
    });
    // CST: the cash open is 14:30Z.
    expect(premarketWindow('2026-11-10')).toEqual({
      fromMs: ms('2026-11-09T22:00:00Z'),
      toMs: ms('2026-11-10T14:30:00Z'),
    });
  });
});

// ── Rounding ────────────────────────────────────────────────────────────────

describe('roundNumeric', () => {
  it.each([
    [0.1234, 4, 0.1234],
    // A tie in the decimal text rounds away from zero, as NUMERIC does; the
    // binary value of 1.00005 sits just below the tie.
    [1.00005, 4, 1.0001],
    [2.675, 2, 2.68],
    [-0.00005, 4, -0.0001],
    [-1.00005, 4, -1.0001],
    [0.12344999999999999, 4, 0.1234],
    [7404.25, 4, 7404.25],
    [1e-7, 4, 0],
    [-1e-7, 4, 0],
    [999.99995, 4, 1000],
    [1.5e-4, 4, 0.0002],
    [0, 4, 0],
  ])('roundNumeric(%s, %s) = %s', (x, scale, want) => {
    expect(roundNumeric(x, scale)).toBe(want);
  });

  it('rejects a value with no decimal text', () => {
    expect(() => roundNumeric(Number.NaN, 4)).toThrow(/cannot round NaN/);
    expect(() => roundNumeric(Number.POSITIVE_INFINITY, 4)).toThrow(
      /cannot round Infinity/,
    );
  });
});

// ── Snapshot comparison ─────────────────────────────────────────────────────

describe('compareSnapshot', () => {
  const stored: SnapshotValues = {
    price: 7404.25,
    change1hPct: 0.0946,
    changeDayPct: null,
    volumeRatio: 0.8691,
  };
  const fresh = (over: Partial<SnapshotValues>): SnapshotResult => ({
    kind: 'fresh',
    snapshot: {
      symbol: 'ES',
      price: 7404.25,
      change1hPct: 0.0946,
      changeDayPct: null,
      volumeRatio: 0.8691,
      latestTs: '2026-11-06T21:55:00.000Z',
      ...over,
    },
  });

  it('is the same when the recompute rounds to the stored four decimals', () => {
    expect(
      compareSnapshot(
        stored,
        fresh({ change1hPct: 0.09455, volumeRatio: 0.86914999 }),
      ),
    ).toEqual({ kind: 'same' });
  });

  it('names the fields that differ and rounds the new values to the column scale', () => {
    expect(
      compareSnapshot(
        stored,
        fresh({ price: 7360.5, changeDayPct: 0.123456, volumeRatio: 0.9 }),
      ),
    ).toEqual({
      kind: 'change',
      fields: ['price', 'changeDayPct', 'volumeRatio'],
      to: {
        price: 7360.5,
        change1hPct: 0.0946,
        changeDayPct: 0.1235,
        volumeRatio: 0.9,
      },
    });
  });

  it('treats a value that becomes null as a change', () => {
    expect(compareSnapshot(stored, fresh({ change1hPct: null }))).toMatchObject(
      { kind: 'change', fields: ['change1hPct'] },
    );
  });

  it('leaves a row alone when the bars no longer support a snapshot', () => {
    expect(
      compareSnapshot(stored, {
        kind: 'stale',
        latestTs: '2026-04-10T20:00:00.000Z',
        ageMinutes: 90,
      }),
    ).toEqual({ kind: 'unrecomputable', why: 'stale (latest bar 90 min old)' });
    expect(compareSnapshot(stored, { kind: 'missing' })).toEqual({
      kind: 'unrecomputable',
      why: 'no bar at or before the row',
    });
  });
});

describe('compareGlobex', () => {
  const stored = {
    globexHigh: 7237,
    globexLow: 7150,
    globexClose: 7162.5,
    globexVwap: 7167.072908332296,
  };
  const now = (over: Partial<Globex> = {}): Globex => ({
    ...stored,
    barCount: 900,
    ...over,
  });

  it('is the same when all four numbers are equal', () => {
    expect(compareGlobex(stored, now())).toEqual({ kind: 'same' });
  });

  it('changes when any of the four differs, comparing the double exactly', () => {
    expect(compareGlobex(stored, now({ globexHigh: 7190.5 }))).toEqual({
      kind: 'change',
      fields: ['globexHigh'],
      to: { ...stored, globexHigh: 7190.5 },
    });
    expect(
      compareGlobex(stored, now({ globexVwap: 7167.072908332297 })),
    ).toMatchObject({ kind: 'change', fields: ['globexVwap'] });
    expect(compareGlobex(stored, now({ globexVwap: null }))).toMatchObject({
      kind: 'change',
      fields: ['globexVwap'],
    });
  });

  it('writes the four keys over malformed stored data, and leaves a window with no bars alone', () => {
    expect(compareGlobex(null, now())).toMatchObject({
      kind: 'change',
      fields: ['all'],
    });
    expect(compareGlobex(stored, null)).toEqual({
      kind: 'unrecomputable',
      why: 'no overnight bars',
    });
  });
});

// ── PCS gate ────────────────────────────────────────────────────────────────

describe('PCS gate flips', () => {
  const fire = (
    id: number,
    from: number,
    to: number,
    signalType = 'pcs_monday',
  ): FireChange => ({
    id,
    firedAtMs: ms('2026-05-04T14:35:00Z') + id * 60_000,
    signalType,
    from,
    to,
    row: {},
  });

  it.each([
    [0.5, true],
    [0.4999, false],
    [2, true],
    [-3, false],
    [0, false],
  ])(
    'pcsPasses(%s) is %s: the detector blocks a basis below 0.5',
    (v, pass) => {
      expect(pcsPasses(v)).toBe(pass);
    },
  );

  it('lists the fires whose gate result crosses 0.5 in either direction, with old and new', () => {
    const flips = gateFlips([
      fire(1, 0.4, 0.6), // blocked -> passes
      fire(2, 0.9, 0.3), // passes -> blocked
      fire(3, 0.6, 0.7), // passes both
      fire(4, -2, -1), // blocked both
      fire(5, 0.5, 0.49), // exactly 0.5 passes; 0.49 does not
      fire(6, 0.2, 0.8, 'e1_long_call'), // the column is shared; listed with its type
    ]);
    expect(flips.map((f) => [f.id, f.from, f.to, f.signalType])).toEqual([
      [1, 0.4, 0.6, 'pcs_monday'],
      [2, 0.9, 0.3, 'pcs_monday'],
      [5, 0.5, 0.49, 'pcs_monday'],
      [6, 0.2, 0.8, 'e1_long_call'],
    ]);
  });
});

// ── Apply gate ──────────────────────────────────────────────────────────────

describe('checkApplyGate', () => {
  const control = (rows: number, matched: number): Control => ({
    rows,
    matched,
    byKind: {},
    byMonth: {},
    samples: [],
  });
  const store = (
    store: 'snapshots' | 'premarket' | 'fires',
    toChange: number,
    c: Control,
  ) => ({ store, toChange, control: c });
  const expects = { snapshots: 100, premarket: 5, fires: 7 };

  it('passes when every total matches and every control set matches 100%', () => {
    expect(
      checkApplyGate(
        [
          store('snapshots', 100, control(400, 400)),
          store('premarket', 5, control(108, 108)),
          store('fires', 7, control(166, 166)),
        ],
        expects,
      ),
    ).toEqual([]);
  });

  it('refuses a total that differs from the approved dry run, naming the store', () => {
    const problems = checkApplyGate(
      [
        store('snapshots', 101, control(400, 400)),
        store('premarket', 5, control(108, 108)),
        store('fires', 7, control(166, 166)),
      ],
      expects,
    );
    expect(problems).toEqual([
      'snapshots: the fresh plan changes 101 rows, --expect-snapshots 100 was given',
    ]);
  });

  it('refuses a control set below 100%, with the rate', () => {
    const problems = checkApplyGate(
      [
        store('snapshots', 100, control(400, 3)),
        store('premarket', 5, control(108, 78)),
        store('fires', 7, control(166, 166)),
      ],
      expects,
    );
    expect(problems).toEqual([
      'snapshots: control set matches 3 of 400 (0.8%), not 100%',
      'premarket: control set matches 78 of 108 (72.2%), not 100%',
    ]);
  });

  it('refuses a store with no control rows at all: nothing proves the method', () => {
    expect(
      checkApplyGate([store('fires', 7, control(0, 0))], { fires: 7 }),
    ).toEqual(['fires: the control set is empty, so the method is unproven']);
  });

  it('checks every planned store, and the approved total only of the stores it has one for', () => {
    // --apply --stores fires: the snapshot and pre-market checks still hold,
    // and only fires has an approved total.
    const planned = [
      store('snapshots', 16580, control(2728, 2728)),
      store('premarket', 35, control(108, 108)),
      store('fires', 0, control(166, 166)),
    ];
    expect(checkApplyGate(planned, { fires: 0 })).toEqual([]);
    expect(
      checkApplyGate(
        [
          store('snapshots', 16580, control(2728, 2700)),
          planned[1]!,
          planned[2]!,
        ],
        { fires: 0 },
      ),
    ).toEqual([
      'snapshots: control set matches 2700 of 2728 (99.0%), not 100%',
    ]);
  });

  it('checks only the stores in the run', () => {
    expect(
      checkApplyGate([store('fires', 7, control(166, 166))], { fires: 7 }),
    ).toEqual([]);
  });
});

describe('snapshotProblems', () => {
  const ok = {
    symbol: 'ES' as const,
    controlRows: 216,
    controlDays: 3,
    attributionInconsistent: 0,
  };

  it('has nothing to say about a control of 200 rows over 3 days with consistent inputs', () => {
    expect(snapshotProblems(ok)).toEqual([]);
    expect(snapshotProblems({ ...ok, controlRows: 200 })).toEqual([]);
  });

  it.each([
    [{ controlRows: 199 }, '199 rows over 3 days'],
    [{ controlDays: 2 }, '216 rows over 2 days'],
    [{ controlRows: 0, controlDays: 0 }, '0 rows over 0 days'],
  ])('refuses a control that is too small: %j', (over, text) => {
    expect(snapshotProblems({ ...ok, ...over })).toEqual([
      `ES: the method control has ${text}, 200 rows over 3 days are needed`,
    ]);
  });

  it('refuses inputs that disagree with computeSnapshot', () => {
    expect(snapshotProblems({ ...ok, attributionInconsistent: 4 })).toEqual([
      'ES: the input bars found for attribution disagree with computeSnapshot on 4 rows',
    ]);
  });
});

// ── Read-only fetch ─────────────────────────────────────────────────────────

describe('readOnlyFetch', () => {
  const URL_ = 'https://ep-test.neon.tech/sql';
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('sends a single query as a one-statement read-only batch and unwraps the answer', async () => {
    const result = { rows: [['on']], fields: [{ name: 'x' }] };
    fetchMock.mockResolvedValue(json({ results: [result] }));
    const res = await readOnlyFetch(URL_, {
      method: 'POST',
      body: JSON.stringify({ query: 'SELECT 1', params: [] }),
      headers: { 'Neon-Connection-String': 'secret' },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      queries: [{ query: 'SELECT 1', params: [] }],
    });
    expect(init.headers).toMatchObject({
      'Neon-Batch-Read-Only': 'true',
      'Neon-Connection-String': 'secret',
    });
    expect(await res.json()).toEqual(result);
  });

  it('passes a read-only batch through untouched', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }));
    const init = {
      method: 'POST',
      body: JSON.stringify({ queries: [{ query: 'SELECT 1', params: [] }] }),
      headers: { 'Neon-Batch-Read-Only': 'true' },
    };
    await readOnlyFetch(URL_, init);
    expect(fetchMock).toHaveBeenCalledWith(URL_, init);
  });

  it('refuses a batch that is not read-only, before any request goes out', async () => {
    await expect(
      readOnlyFetch(URL_, {
        method: 'POST',
        body: JSON.stringify({ queries: [{ query: 'DELETE FROM x' }] }),
        headers: {},
      }),
    ).rejects.toThrow(/refusing a transaction that is not read-only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an error answer through for the driver to raise', async () => {
    fetchMock.mockResolvedValue(json({ message: 'syntax error' }, 400));
    const res = await readOnlyFetch(URL_, {
      method: 'POST',
      body: JSON.stringify({ query: 'SELEC', params: [] }),
      headers: {},
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: 'syntax error' });
  });

  it('throws on a success answer that has no result', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }));
    await expect(
      readOnlyFetch(URL_, {
        method: 'POST',
        body: JSON.stringify({ query: 'SELECT 1', params: [] }),
        headers: {},
      }),
    ).rejects.toThrow(/unexpected answer from Neon/);
  });

  it('refuses a request body it cannot read', async () => {
    await expect(readOnlyFetch(URL_, { method: 'POST' })).rejects.toThrow(
      /request body is not JSON text/,
    );
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

describe('runRecompute guards', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recompute-guards-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getDb).mockClear();
    writeFileSync(join(dir, 'backup.jsonl'), '');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const options = (over = {}) => ({
    workDir: join(dir, 'work'),
    apply: true,
    force: false,
    stores: ['snapshots', 'premarket', 'fires'] as (
      | 'snapshots'
      | 'premarket'
      | 'fires'
    )[],
    backup: join(dir, 'backup.jsonl'),
    expectSnapshots: 1,
    expectPremarket: 1,
    expectFires: 1,
    deleteJunkStale: false,
    expectJunkDeletes: null,
    rewriteStaleAtWrite: false,
    expectStaleRewrites: null,
    detectorDays: null,
    ...over,
  });

  it('refuses --apply during market hours before it touches the database', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T16:00:00Z')); // Monday 11:00 ET
    expect(await runRecompute(options())).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Refusing to --apply during market hours/),
    );
    expect(getDb).not.toHaveBeenCalled();
  });

  it('does not let market hours stop a dry run: it goes on to the database', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T16:00:00Z'));
    expect(await runRecompute(options({ apply: false }))).toBe(1);
    expect(getDb).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/getDb must not be reached/),
    );
  });

  it('exits non-zero, before the database, when the Phase 2 backup is missing', async () => {
    expect(
      await runRecompute(options({ backup: join(dir, 'missing.jsonl') })),
    ).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/ENOENT/));
    expect(getDb).not.toHaveBeenCalled();
  });

  it('exits non-zero, before the database, naming the line of a malformed backup', async () => {
    writeFileSync(join(dir, 'backup.jsonl'), 'not json\n');
    expect(await runRecompute(options({ apply: false }))).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/backup\.jsonl:1: not JSON/),
    );
    expect(getDb).not.toHaveBeenCalled();
  });

  it('needs no backup for the fires store alone', async () => {
    expect(
      await runRecompute(
        options({ apply: false, stores: ['fires'], backup: null }),
      ),
    ).toBe(1);
    expect(getDb).toHaveBeenCalled();
  });
});

// ── Attribution (the Phase 2 backup against the bars now) ───────────────────

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

const old = (
  ts: string,
  op: 'update' | 'delete',
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

describe('parseBackup', () => {
  const line = (op: string, ts: string) =>
    JSON.stringify({
      op,
      reason: 'archive_span',
      row: {
        id: '1',
        symbol: 'ES',
        ts,
        open: '7000.0000',
        high: '7001.2500',
        low: '6999.0000',
        close: '7000.5000',
        volume: '300',
        buy_volume: null,
      },
    });

  it('reads each line into a bar with its op, ignoring the columns it does not use', () => {
    const text = `${line('update', '2026-04-07T14:30:00Z')}\n\n${line('delete', '2026-04-07T14:31:00Z')}\n`;
    expect(parseBackup(text, 'b.jsonl')).toEqual([
      {
        op: 'update',
        symbol: 'ES',
        tsMs: ms('2026-04-07T14:30:00Z'),
        open: 7000,
        high: 7001.25,
        low: 6999,
        close: 7000.5,
        volume: 300,
      },
      {
        op: 'delete',
        symbol: 'ES',
        tsMs: ms('2026-04-07T14:31:00Z'),
        open: 7000,
        high: 7001.25,
        low: 6999,
        close: 7000.5,
        volume: 300,
      },
    ]);
  });

  it('leaves open undefined for a row without it', () => {
    const text = JSON.stringify({
      op: 'update',
      row: {
        symbol: 'ES',
        ts: '2026-04-07T14:30:00Z',
        high: '2',
        low: '1',
        close: '1.5',
        volume: '3',
      },
    });
    expect(parseBackup(text, 'b.jsonl')[0]?.open).toBeUndefined();
  });

  const badRow = (over: object) =>
    JSON.stringify({
      op: 'update',
      row: {
        symbol: 'ES',
        ts: '2026-04-07T14:30:00Z',
        high: '1',
        low: '1',
        close: '1',
        volume: '1',
        ...over,
      },
    });

  it.each([
    ['{not json', /b\.jsonl:2: not JSON/],
    [JSON.stringify({ op: 'merge', row: {} }), /b\.jsonl:2: op/],
    [badRow({ close: 'x' }), /b\.jsonl:2: row\.close not a number/],
    [badRow({ ts: 'yesterday' }), /b\.jsonl:2: ts "yesterday" is not a date/],
  ])('names the line of a bad row: %s', (bad, message) => {
    const text = `${line('update', '2026-04-07T14:30:00Z')}\n${bad}\n`;
    expect(() => parseBackup(text, 'b.jsonl')).toThrow(message);
  });
});

describe('buildRepair', () => {
  const T = (m: number) => `2026-04-07T14:${String(m).padStart(2, '0')}:00Z`;

  it('records what differs between the backup and the bars now, field by field', () => {
    const repair = buildRepair(
      [
        old(T(1), 'update', 7000), // same close and volume now
        old(T(2), 'update', 7050), // close changed
        old(T(3), 'update', 7000, 40), // volume changed
        old(T(4), 'update', 7000, 100, { high: 7090 }), // high changed only
        old(T(5), 'update', 7000), // gone now
        old(T(6), 'delete', 7000),
      ],
      currentOf([
        bar(T(1), 7000),
        bar(T(2), 7000),
        bar(T(3), 7000),
        bar(T(4), 7000),
      ]),
    );
    // The update whose bar is gone (T(5)) counts as deleted.
    expect(repair.deleted).toEqual([ms(T(5)), ms(T(6))]);
    expect([...repair.closeChanged].sort()).toEqual(
      [ms(T(2)), ms(T(5))].sort(),
    );
    expect(repair.volumeTouched).toEqual([ms(T(3)), ms(T(5)), ms(T(6))]);
    expect(repair.windowTouched).toEqual([
      ms(T(2)),
      ms(T(3)),
      ms(T(4)),
      ms(T(5)),
      ms(T(6)),
    ]);
  });
});

describe('snapshotInputs', () => {
  // 2026-04-14 is EDT: open 13:30Z. at = 14:31:30, so the last closed bar is 14:30.
  const AT = ms('2026-04-14T14:31:30Z');
  const OPEN = ms('2026-04-14T13:30:00Z');
  const bars = [
    bar('2026-04-14T13:30:00Z', 7000),
    bar('2026-04-14T13:31:00Z', 7001),
    bar('2026-04-14T14:30:00Z', 7005),
    bar('2026-04-14T14:31:00Z', 7099),
  ];

  it('takes the latest closed bar, the hour-ago bar and the day-open bar', () => {
    const inputs = snapshotInputs(bars, AT, OPEN);
    expect(inputs.latest?.close).toBe(7005);
    expect(inputs.hourAgo?.close).toBe(7001);
    expect(inputs.dayOpen?.close).toBe(7000);
  });

  it('drops an hour-ago bar older than 15 minutes before at - 60 min, and a late day-open bar', () => {
    const inputs = snapshotInputs(
      [
        bar('2026-04-14T13:10:00Z', 7000), // 21 min before 13:31:30
        bar('2026-04-14T13:50:00Z', 7001), // 20 min after the open
        bar('2026-04-14T14:30:00Z', 7005),
      ],
      AT,
      OPEN,
    );
    expect(inputs.hourAgo).toBeNull();
    expect(inputs.dayOpen).toBeNull();
    expect(inputs.latest?.close).toBe(7005);
  });

  it('has no day-open bar when there is no cash session, or before the open bar closed', () => {
    expect(snapshotInputs(bars, AT, null).dayOpen).toBeNull();
    const early = ms('2026-04-14T13:30:30Z'); // the 13:30 bar is still printing
    expect(snapshotInputs(bars, early, OPEN).dayOpen).toBeNull();
  });
});

describe('affectedSnapshotFields', () => {
  const AT = ms('2026-04-14T14:31:30Z');
  const OPEN = ms('2026-04-14T13:30:00Z');
  const bars = [
    bar('2026-04-14T13:30:00Z', 7000),
    bar('2026-04-14T13:31:00Z', 7001),
    bar('2026-04-14T14:20:00Z', 7003),
    bar('2026-04-14T14:30:00Z', 7005),
    bar('2026-04-14T14:31:00Z', 7099),
  ];
  interface Changes {
    deleted?: string[];
    close?: string[];
    volume?: string[];
  }
  const repairOf = (over: Changes): Repair => {
    const ascending = (a: number, b: number) => a - b;
    const deleted = (over.deleted ?? []).map(ms).sort(ascending);
    return {
      deleted,
      closeChanged: new Set((over.close ?? []).map(ms)),
      volumeTouched: [...(over.volume ?? []).map(ms), ...deleted].sort(
        ascending,
      ),
      windowTouched: [],
    };
  };
  const fieldsOf = (over: Changes): string[] =>
    [...affectedSnapshotFields(repairOf(over), bars, AT, OPEN)].sort();

  it.each([
    ['nothing changed', {}, []],
    [
      'the latest closed bar close changed',
      { close: ['2026-04-14T14:30:00Z'] },
      ['changeDayPct', 'change1hPct', 'price'],
    ],
    [
      'the bar of the open minute changed (not an input)',
      { close: ['2026-04-14T14:31:00Z'] },
      [],
    ],
    [
      'the hour-ago bar changed',
      { close: ['2026-04-14T13:31:00Z'] },
      ['change1hPct'],
    ],
    [
      'the day-open bar changed',
      { close: ['2026-04-14T13:30:00Z'] },
      ['changeDayPct'],
    ],
    [
      'a bar deleted after the latest closed bar',
      { deleted: ['2026-04-14T14:30:30Z'] },
      ['changeDayPct', 'change1hPct', 'price', 'volumeRatio'],
    ],
    [
      'a bar deleted before the hour-ago bar',
      { deleted: ['2026-04-14T13:20:00Z'] },
      ['volumeRatio'],
    ],
    [
      'a bar deleted after the hour-ago bar and before at - 60 min',
      { deleted: ['2026-04-14T13:31:20Z'] },
      ['change1hPct', 'volumeRatio'],
    ],
    [
      'a volume that changed inside the 20 days',
      { volume: ['2026-04-02T15:00:00Z'] },
      ['volumeRatio'],
    ],
    [
      'a volume that changed before the 20 days',
      { volume: ['2026-03-20T15:00:00Z'] },
      [],
    ],
    [
      'a volume that changed in the open minute',
      { volume: ['2026-04-14T14:31:00Z'] },
      [],
    ],
  ] as [string, Changes, string[]][])('%s', (_name, over, want) => {
    expect(fieldsOf(over)).toEqual([...want].sort());
  });

  it('flags the day change, and the 1h change, when the bar that would have been the reference was deleted', () => {
    // No bar at 13:30 now: the first bar after the open is 13:32. A bar deleted
    // at 13:30:00 was the old day-open bar, and (13:31:30 being the hour-ago
    // moment) the old hour-ago bar too.
    const shifted = [
      bar('2026-04-14T13:32:00Z', 7001),
      bar('2026-04-14T14:30:00Z', 7005),
    ];
    const fields = affectedSnapshotFields(
      repairOf({ deleted: ['2026-04-14T13:30:00Z'] }),
      shifted,
      AT,
      OPEN,
    );
    expect([...fields].sort()).toEqual([
      'change1hPct',
      'changeDayPct',
      'volumeRatio',
    ]);
  });

  it('flags only the price chain without a cash session', () => {
    const fields = affectedSnapshotFields(
      repairOf({ close: ['2026-04-14T14:30:00Z'] }),
      bars,
      AT,
      null,
    );
    expect([...fields].sort()).toEqual([
      'change1hPct',
      'changeDayPct',
      'price',
    ]);
  });
});

describe('inputsMatchSnapshot', () => {
  const AT = ms('2026-04-14T14:31:30Z');
  const OPEN = ms('2026-04-14T13:30:00Z');
  const bars = [
    bar('2026-04-14T13:30:00Z', 7000),
    bar('2026-04-14T13:31:00Z', 7000),
    bar('2026-04-14T14:30:00Z', 7007),
  ];
  const snapshot = {
    price: 7007,
    change1hPct: 0.1,
    changeDayPct: 0.1,
    latestTs: '2026-04-14T14:30:00.000Z',
  };

  it('is true when the latest bar and both references follow from the inputs', () => {
    expect(inputsMatchSnapshot(snapshotInputs(bars, AT, OPEN), snapshot)).toBe(
      true,
    );
  });

  it.each([
    ['another latest bar', { latestTs: '2026-04-14T13:31:00.000Z' }],
    ['another price', { price: 7006 }],
    ['another 1h change', { change1hPct: 0.2 }],
    ['a day change where none follows', { changeDayPct: null }],
  ])('is false for %s', (_name, over) => {
    expect(
      inputsMatchSnapshot(snapshotInputs(bars, AT, OPEN), {
        ...snapshot,
        ...over,
      }),
    ).toBe(false);
  });

  it('is false when there is no latest bar', () => {
    expect(inputsMatchSnapshot(snapshotInputs([], AT, OPEN), snapshot)).toBe(
      false,
    );
  });
});

describe('pre-market window attribution', () => {
  const from = ms('2026-05-12T22:00:00Z');
  const to = ms('2026-05-13T13:30:00Z');

  it('flags a window only when a changed or deleted bar falls inside it, end exclusive', () => {
    const outside = buildRepair(
      [
        old('2026-05-12T21:59:00Z', 'delete', 7000),
        old('2026-05-13T13:30:00Z', 'delete', 7000),
      ],
      new Map(),
    );
    expect(windowAffected(outside, from, to)).toBe(false);
    const inside = buildRepair(
      [old('2026-05-13T03:00:00Z', 'delete', 7000)],
      new Map(),
    );
    expect(windowAffected(inside, from, to)).toBe(true);
    const first = buildRepair(
      [old('2026-05-12T22:00:00Z', 'update', 7000, 100, { low: 6990 })],
      currentOf([bar('2026-05-12T22:00:00Z', 7000)]),
    );
    expect(windowAffected(first, from, to)).toBe(true);
  });

  it('aggregates like the cron: max high, min low, the last close, volume-weighted close', () => {
    expect(aggregateWindow([])).toBeNull();
    expect(
      aggregateWindow([
        bar('2026-05-12T23:00:00Z', 7200, 100, { high: 7250, low: 7100 }),
        bar('2026-05-13T03:00:00Z', 7205, 300, { high: 7210, low: 7190 }),
      ]),
    ).toEqual({ high: 7250, low: 7100, close: 7205, vwap: 7203.75 });
    expect(
      aggregateWindow([bar('2026-05-12T23:00:00Z', 7200, 0)])?.vwap,
    ).toBeNull();
  });

  it('puts back what Phase 2 changed: updated rows at their old values, deleted rows added', () => {
    const now = [
      bar('2026-05-12T23:00:00Z', 7200, 100),
      bar('2026-05-13T03:00:00Z', 7205, 300),
    ];
    const before = preRepairWindow(
      now,
      [
        old('2026-05-12T23:00:00Z', 'update', 7260, 100, { high: 7300 }),
        old('2026-05-13T01:00:00Z', 'delete', 7210, 50),
        old('2026-05-14T01:00:00Z', 'delete', 7000, 50), // outside the window
      ],
      from,
      to,
    );
    expect(before.map((b) => [b.tsMs, b.close, b.high])).toEqual([
      [ms('2026-05-12T23:00:00Z'), 7260, 7300],
      [ms('2026-05-13T01:00:00Z'), 7210, 7210],
      [ms('2026-05-13T03:00:00Z'), 7205, 7205],
    ]);
  });
});

describe('classifyMismatch', () => {
  const row = (over: object = {}) => ({
    fields: ['volumeRatio'] as ('volumeRatio' | 'price' | 'change1hPct')[],
    atMs: ms('2026-10-06T14:31:30Z'),
    storedPrice: 7001,
    olderBars: [] as { ageMin: number; close: number }[],
    ...over,
  });

  it('calls a volume-ratio-only miss whose 20-day window reaches the September outage september-window', () => {
    expect(classifyMismatch(row())).toEqual({
      cls: 'september-window',
      ageMin: null,
      olderMatch: false,
    });
  });

  it.each([
    // The window of the last 20 days must overlap 09-03 .. 09-29 (end exclusive 09-30).
    ['2026-10-19T23:00:00Z', 'september-window'],
    ['2026-10-20T00:00:00Z', 'unexplained'],
    ['2026-09-02T23:59:00Z', 'unexplained'],
    ['2026-09-03T00:00:00Z', 'september-window'],
  ])('at %s the volume-ratio-only miss is %s', (at, cls) => {
    expect(classifyMismatch(row({ atMs: ms(at) })).cls).toBe(cls);
  });

  it('does not call a miss september-window when another field differs too', () => {
    expect(
      classifyMismatch(row({ fields: ['volumeRatio', 'price'] })).cls,
    ).toBe('unexplained');
  });

  it('calls it late-bar when the stored price is the close of a bar 1 to 14 minutes older, and gives the newest age', () => {
    const olderBars = [
      { ageMin: 2, close: 7001 },
      { ageMin: 5, close: 7001 },
    ];
    expect(
      classifyMismatch(row({ fields: ['price', 'change1hPct'], olderBars })),
    ).toEqual({ cls: 'late-bar', ageMin: 2, olderMatch: true });
  });

  it.each([
    [0, 'unexplained'],
    [1, 'late-bar'],
    [14, 'late-bar'],
    [15, 'unexplained'],
  ])('a matching bar %s minutes older is %s', (ageMin, cls) => {
    expect(
      classifyMismatch(
        row({ fields: ['price'], olderBars: [{ ageMin, close: 7001 }] }),
      ).cls,
    ).toBe(cls);
  });

  it('calls it unexplained when no older bar has the stored price', () => {
    expect(
      classifyMismatch(
        row({ fields: ['price'], olderBars: [{ ageMin: 3, close: 7002 }] }),
      ),
    ).toEqual({ cls: 'unexplained', ageMin: null, olderMatch: false });
  });

  it('does not call a miss late-bar when the stored price already equals the latest close, though an older bar closed there too', () => {
    // Only the volume ratio differs, outside the September window: a price that
    // matches today's latest bar needs no late bar, whatever an older bar closed at.
    expect(
      classifyMismatch(
        row({
          atMs: ms('2026-10-29T22:05:21Z'),
          olderBars: [{ ageMin: 3, close: 7001 }],
        }),
      ),
    ).toEqual({ cls: 'unexplained', ageMin: null, olderMatch: true });
  });

  it('checks september-window before late-bar', () => {
    expect(
      classifyMismatch(row({ olderBars: [{ ageMin: 3, close: 7001 }] })).cls,
    ).toBe('september-window');
  });
});

describe('classifyThinMiss', () => {
  const miss = (over: object = {}) => ({
    fields: ['volumeRatio'] as ('volumeRatio' | 'price' | 'change1hPct')[],
    // Outside the September window, so a volume-ratio-only miss is not september-window.
    atMs: ms('2026-11-03T15:31:21Z'),
    storedPrice: 110.5,
    olderBars: [] as { ageMin: number; close: number }[],
    storedVolumeRatio: 0.5 as number | null,
    recomputedVolumeRatio: 0.5002 as number | null,
    ...over,
  });

  it('calls a miss late-bar when the stored price is the close of a bar 1 to 14 minutes older, whatever else differs', () => {
    expect(
      classifyThinMiss(
        miss({
          fields: ['price', 'change1hPct', 'volumeRatio'],
          olderBars: [{ ageMin: 1, close: 110.5 }],
          // The volume ratio is a consequence of the late bar: it may be on either side.
          recomputedVolumeRatio: 0.4,
        }),
      ),
    ).toEqual({ cls: 'late-bar', ageMin: 1 });
  });

  it('calls a volume-ratio-only miss late-volume when the stored ratio is strictly below the recomputed one', () => {
    expect(classifyThinMiss(miss())).toEqual({
      cls: 'late-volume',
      ageMin: null,
    });
  });

  it.each([
    [0.5063, 0.5062], // ZN 2026-11-06: a fill on a prior day lowered the ratio past a rounding edge
    [1.0001, 1],
    [0.0001, 0],
  ])(
    'calls a stored ratio one unit of the column above the recomputed one (%s against %s) late-volume: a prior-day fill lowers the ratio',
    (stored, recomputed) => {
      expect(
        classifyThinMiss(
          miss({
            storedVolumeRatio: stored,
            recomputedVolumeRatio: recomputed,
          }),
        ),
      ).toEqual({ cls: 'late-volume', ageMin: null });
    },
  );

  it.each([
    ['two units above the recomputed ratio', 0.5, 0.4998],
    ['far above the recomputed ratio', 0.9, 0.5],
    ['null while the recompute has a ratio', null, 0.5],
    ['a number while the recompute has none', 0.5, null],
  ])(
    'does not call a volume-ratio miss late-volume when the stored ratio is %s',
    (_why, stored, recomputed) => {
      expect(
        classifyThinMiss(
          miss({
            storedVolumeRatio: stored,
            recomputedVolumeRatio: recomputed,
          }),
        ),
      ).toEqual({ cls: 'other', ageMin: null });
    },
  );

  it.each([
    [['change1hPct', 'volumeRatio']],
    [['changeDayPct']],
    [['price', 'volumeRatio']],
    [['price']],
  ] as const)(
    'is other when %j differs and no late bar explains it, though the volume ratio is below',
    (fields) => {
      expect(classifyThinMiss(miss({ fields: [...fields] }))).toEqual({
        cls: 'other',
        ageMin: null,
      });
    },
  );

  it('is other when the matching older bar is too old, or the stored price equals the latest close', () => {
    expect(
      classifyThinMiss(
        miss({
          fields: ['price'],
          olderBars: [{ ageMin: 15, close: 110.5 }],
        }),
      ).cls,
    ).toBe('other');
    expect(
      classifyThinMiss(
        miss({ fields: ['price'], olderBars: [{ ageMin: 3, close: 110.4 }] }),
      ).cls,
    ).toBe('other');
  });
});

describe('mergeStateBars and findMergeState', () => {
  const t = (m: number) =>
    ms(`2026-04-08T07:${String(m).padStart(2, '0')}:00Z`);
  const current = (
    m: number,
    o: number,
    h: number,
    l: number,
    c: number,
  ): Bar => ({
    tsMs: t(m),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 10,
  });
  const backup = (
    m: number,
    o: number,
    h: number,
    l: number,
    c: number,
  ): BackupBar => ({
    op: 'update',
    symbol: 'ES',
    ...current(m, o, h, l, c),
  });
  const updatesOf = (...b: BackupBar[]) => new Map(b.map((x) => [x.tsMs, x]));

  // Minutes 5, 10, 11, 20 and 25 hold bars; 25 is the latest closed bar.
  const bars = [
    current(5, 6800, 6800, 6800, 6800),
    current(10, 6810, 6812, 6808, 6811),
    current(11, 6811, 6813, 6809, 6812),
    current(20, 6820, 6822, 6818, 6821),
    current(25, 6830, 6832, 6828, 6831),
  ];
  const latest = bars[4] as Bar;

  it('lists the latest closed bar and the bars up to 14 minutes older, newest first, with their age', () => {
    const views = mergeStateBars(bars, new Map(), latest);
    expect(views.map((v) => [v.ageMin, v.tsMs])).toEqual([
      [0, t(25)],
      [5, t(20)],
      [14, t(11)],
    ]);
    // Minute 10 is 15 minutes older: out.
    expect(views.every((v) => v.pre == null && !v.changed)).toBe(true);
  });

  it('has pre-repair values only for a bar the backup updated, and calls it changed only when a value differs', () => {
    const views = mergeStateBars(
      bars,
      updatesOf(
        backup(20, 6820, 6890, 6818, 6821), // high was merged up
        { ...backup(11, 6811, 6813, 6809, 6812), volume: 99 }, // only the volume differs
      ),
      latest,
    );
    const byAge = Object.fromEntries(views.map((v) => [v.ageMin, v]));
    expect(byAge[5]).toMatchObject({
      pre: { open: 6820, high: 6890, low: 6818, close: 6821 },
      now: { open: 6820, high: 6822, low: 6818, close: 6821 },
      changed: true,
    });
    expect(byAge[14]).toMatchObject({ changed: true });
    expect(byAge[14]?.pre).not.toBeNull();
    expect(byAge[0]?.pre).toBeNull();
  });

  it('does not call a bar changed when the backup holds the same values', () => {
    const views = mergeStateBars(
      bars,
      updatesOf(backup(20, 6820, 6822, 6818, 6821)),
      latest,
    );
    expect(views.find((v) => v.ageMin === 5)).toMatchObject({
      changed: false,
    });
    expect(views.find((v) => v.ageMin === 5)?.pre).not.toBeNull();
  });

  it('is empty-handed when the latest bar is the only bar', () => {
    expect(mergeStateBars([latest], new Map(), latest)).toHaveLength(1);
  });

  const views = (...b: BackupBar[]): MergeBarView[] =>
    mergeStateBars(bars, updatesOf(...b), latest);

  it('finds the newest changed bar whose pre-repair range holds the price and whose current range does not', () => {
    const found = findMergeState(
      views(
        backup(20, 6820, 6890, 6818, 6821),
        backup(11, 6811, 6895, 6809, 6812),
      ),
      6880,
    );
    expect(found?.tsMs).toBe(t(20)); // both hold 6880; the newer one is named
  });

  it.each([
    ['no bar was updated', []],
    [
      'the pre-repair range does not hold the price',
      [backup(20, 6820, 6850, 6818, 6821)],
    ],
    [
      'the current range still holds the price',
      [backup(20, 6820, 6890, 6818, 6821)],
    ],
    ['the bar is unchanged', [backup(20, 6820, 6822, 6818, 6821)]],
  ] as [string, BackupBar[]][])('finds nothing when %s', (why, updates) => {
    // 6880 is inside [6818, 6890] but not inside the current [6818, 6822]; the
    // cases above break one condition each (the third is tested at 6820).
    const price =
      why === 'the current range still holds the price' ? 6820 : 6880;
    expect(findMergeState(views(...updates), price)).toBeNull();
  });

  it('holds the bounds of the pre-repair range', () => {
    const v = views(backup(20, 6820, 6890, 6850, 6821));
    expect(findMergeState(v, 6850)?.tsMs).toBe(t(20));
    expect(findMergeState(v, 6890)?.tsMs).toBe(t(20));
    expect(findMergeState(v, 6849.75)).toBeNull();
    expect(findMergeState(v, 6890.25)).toBeNull();
  });
});

describe('volumeRatioWriteText', () => {
  const change = (
    symbol: 'ES' | 'NQ',
    from: number | null,
    to: number | null,
    fields: SnapshotChange['fields'] = ['volumeRatio'],
  ): SnapshotChange => ({
    id: 1,
    symbol,
    tsMs: 0,
    fields,
    from: {
      price: 1,
      change1hPct: null,
      changeDayPct: null,
      volumeRatio: from,
    },
    to: { price: 1, change1hPct: null, changeDayPct: null, volumeRatio: to },
    row: {},
  });

  it('gives the count, the median, p90 and max of |relative change|, and how many are under 1%', () => {
    const changes = [
      change('ES', 1, 1.005), // 0.5%
      change('ES', 1, 0.98), // 2%
      change('ES', 1, 1.1), // 10%
      change('ES', 1, 1.5), // 50%
      change('ES', 2, 2.002), // 0.1%
      change('NQ', 1, 9), // another symbol
      change('ES', 1, 7, ['price']), // does not write the volume ratio
    ];
    expect(volumeRatioWriteText(changes, 'ES')).toBe(
      'volume-ratio writes: 5; |relative change| median 2.00%, p90 50.00%, max 50.00%; under 1%: 2; from or to null: 0',
    );
  });

  it('counts a null on either end apart, and has no spread without a pair', () => {
    expect(
      volumeRatioWriteText(
        [change('NQ', null, 0.4), change('NQ', 0.4, null), change('NQ', 0, 1)],
        'NQ',
      ),
    ).toBe('volume-ratio writes: 3; from or to null: 3');
    expect(volumeRatioWriteText([], 'ES')).toBe(
      'volume-ratio writes: 0; from or to null: 0',
    );
  });
});

describe("finding a stored row's inputs by value", () => {
  const AT = ms('2026-04-12T22:30:02Z'); // Sunday, 27 hours after the junk bar
  const OPEN = ms('2026-04-12T13:30:00Z');
  const real = [
    bar('2026-04-12T22:27:00Z', 6769.5),
    bar('2026-04-12T22:28:00Z', 6770),
    bar('2026-04-12T22:29:00Z', 6771.25),
  ];
  const stored = (over: object = {}) => ({
    price: 8283.5,
    change1hPct: 0,
    changeDayPct: null,
    ...over,
  });
  const series = (backup: BackupBar[], current: Bar[] = real) =>
    buildPreSeries(backup, current);

  it('finds the price of a bar Phase 2 deleted, though newer unrepaired bars exist (the 04-12 rows)', () => {
    const rule = attributeByValue(
      series([old('2026-04-11T19:52:00Z', 'delete', 8283.5)]),
      AT,
      OPEN,
      stored(),
    );
    expect([...rule.fields].sort()).toEqual([
      'change1hPct',
      'changeDayPct',
      'price',
    ]);
    expect(rule.hits.map((h) => [h.field, h.bar.repair, h.bar.tsMs])).toEqual([
      ['price', 'deleted', ms('2026-04-11T19:52:00Z')],
      ['change1hPct', 'deleted', ms('2026-04-11T19:52:00Z')],
    ]);
    expect(rule.unmatched).toEqual([]);
  });

  it('finds the price of a bar whose close Phase 2 changed (the same blind spot)', () => {
    const current = [bar('2026-04-12T22:20:00Z', 7499.75), ...real];
    const rule = attributeByValue(
      series([old('2026-04-12T22:20:00Z', 'update', 7550)], current),
      AT,
      OPEN,
      stored({ price: 7550, change1hPct: null }),
    );
    expect([...rule.fields].sort()).toEqual([
      'change1hPct',
      'changeDayPct',
      'price',
    ]);
    expect(rule.hits[0]).toMatchObject({
      field: 'price',
      bar: { repair: 'close-changed', closePre: 7550, closeNow: 7499.75 },
    });
  });

  it('leaves a row alone when a newer unrepaired bar shares the stored close', () => {
    const current = [bar('2026-04-12T22:00:00Z', 8283.5), ...real];
    const rule = attributeByValue(
      series([old('2026-04-11T19:52:00Z', 'delete', 8283.5)], current),
      AT,
      OPEN,
      stored({ change1hPct: null }),
    );
    expect(rule.fields.size).toBe(0);
    expect(rule.hits).toEqual([]);
  });

  it('finds the hour-ago close from the stored 1h change, to the tolerance of its rounding', () => {
    // price 6771.25 against a deleted hour-ago close of 6866.5 (-1.3871%).
    const current = [...real];
    const hour = 6866.5;
    const pct = Math.round(((6771.25 - hour) / hour) * 100 * 1e4) / 1e4;
    const rule = attributeByValue(
      series([old('2026-04-12T21:25:00Z', 'delete', hour)], current),
      AT,
      OPEN,
      stored({ price: 6771.25, change1hPct: pct }),
    );
    expect([...rule.fields]).toEqual(['change1hPct']);
    expect(rule.hits.map((h) => h.field)).toEqual(['change1hPct']);
    // The price matched a real bar (6771.25 is in the series) and is untouched.
    expect(rule.unmatched).toEqual([]);
  });

  it('finds the day-open close from the stored day change', () => {
    const open = 6800.25;
    const pct = Math.round(((6771.25 - open) / open) * 100 * 1e4) / 1e4;
    const rule = attributeByValue(
      series([old('2026-04-12T13:30:00Z', 'delete', open)]),
      AT,
      OPEN,
      stored({ price: 6771.25, change1hPct: null, changeDayPct: pct }),
    );
    expect([...rule.fields]).toEqual(['changeDayPct']);
    expect(rule.hits[0]?.bar.tsMs).toBe(ms('2026-04-12T13:30:00Z'));
  });

  it('counts a field with no match, skips a null field, and does not look past 96 hours', () => {
    const rule = attributeByValue(
      series([old('2026-04-07T22:00:00Z', 'delete', 8283.5)]), // 5.0 days earlier
      AT,
      OPEN,
      stored({ change1hPct: 0.5 }),
    );
    expect(rule.fields.size).toBe(0);
    expect(rule.unmatched).toEqual(['price', 'change1hPct']);
    // A null day change is not looked for, so it is not unmatched either.
  });

  it('gives the newest bar with the stored close, repaired or not, and null when none has it', () => {
    const series: PreBar[] = [
      {
        tsMs: ms('2026-04-12T22:00:00Z'),
        closePre: 7000,
        closeNow: 7000,
        repair: null,
      },
      {
        tsMs: ms('2026-04-12T22:10:00Z'),
        closePre: 7000,
        closeNow: 7000,
        repair: null,
      },
      {
        tsMs: ms('2026-04-12T22:20:00Z'),
        closePre: 7005,
        closeNow: 7005,
        repair: null,
      },
    ];
    const at = ms('2026-04-12T22:45:00Z');
    const stored = { price: 7000, change1hPct: null, changeDayPct: null };
    // The newest bar closing at 7000 is the 22:10 one, an unrepaired bar: no hit, but it is named.
    const hit = attributeByValue(series, at, null, stored);
    expect(hit.priceBar?.tsMs).toBe(ms('2026-04-12T22:10:00Z'));
    expect(hit.hits).toEqual([]);
    expect(hit.unmatched).toEqual([]);
    // No bar closes at 7001.
    const none = attributeByValue(series, at, null, { ...stored, price: 7001 });
    expect(none.priceBar).toBeNull();
    expect(none.unmatched).toEqual(['price']);
  });

  it('treats an update whose bar is gone now as a deleted bar', () => {
    const backup = [old('2026-04-11T19:52:00Z', 'update', 8283.5)];
    const repair = buildRepair(backup, currentOf(real));
    expect(repair.deleted).toEqual([ms('2026-04-11T19:52:00Z')]);
    const pre = buildPreSeries(backup, real);
    expect(pre.find((b) => b.closePre === 8283.5)).toMatchObject({
      repair: 'deleted',
      closeNow: null,
    });
    expect(
      attributeByValue(pre, AT, OPEN, stored({ change1hPct: null })).hits[0]
        ?.bar.repair,
    ).toBe('deleted');
  });

  it('marks an unchanged backed-up bar as not repaired', () => {
    const pre = buildPreSeries(
      [old('2026-04-12T22:27:00Z', 'update', 6769.5)],
      real,
    );
    expect(pre.find((b) => b.tsMs === ms('2026-04-12T22:27:00Z'))?.repair).toBe(
      null,
    );
  });
});
