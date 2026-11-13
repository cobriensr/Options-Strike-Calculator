// @vitest-environment node

/**
 * Unit tests for how `--repair front-month` changes the derived-store recompute
 * (Phase 6b of docs/superpowers/specs/2026-11-06-futures-session-front-month.md): the
 * argument rules, the scope edges, the control set-aside and the refusals that come
 * before any database read. The attribution, the profile and its backup reader are in
 * futures-derived-front-month.test.ts; everything that touches SQL runs against pglite
 * in futures-derived-front-month-pglite.test.ts.
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

import { getDb } from '../../api/_lib/db.js';
import type { SnapshotField } from './futures-derived-attribution.js';
import {
  BASIS_LOOKBACK_MS,
  SNAPSHOT_LOOKBACK_MS,
  SPAN,
  parseRecomputeArgs,
  premarketInScope,
  runRecompute,
  scopeRanges,
  setAsideControl,
  type RecomputeOptions,
  type SnapshotOutcome,
} from './futures-derived-recompute.js';

const ms = (iso: string): number => Date.parse(iso);

// ── Arguments ───────────────────────────────────────────────────────────────

describe('parseRecomputeArgs with --repair front-month', () => {
  const FRONT = ['--repair', 'front-month', '--backup', 'b.jsonl'];
  const DEFAULTS = {
    workDir: 'docs/tmp/futures-derived-recompute-front-month',
    apply: false,
    force: false,
    stores: ['snapshots', 'premarket', 'fires'],
    roots: ['ES', 'NQ', 'ZN', 'RTY', 'CL', 'GC'],
    backup: 'b.jsonl',
    expectSnapshots: null,
    expectPremarket: null,
    expectFires: null,
    deleteJunkStale: false,
    expectJunkDeletes: null,
    rewriteStaleAtWrite: false,
    expectStaleRewrites: null,
    frozen: false,
    volumeNull: false,
    deleteFrozenStale: false,
    expectFrozenDeletes: null,
    nullVolumeRatio: false,
    expectVolumeNulls: null,
    detectorDays: null,
    envFile: null,
  };

  it('selects the profile and gives it a work dir of its own', () => {
    expect(parseRecomputeArgs(FRONT)).toEqual({
      ...DEFAULTS,
      repair: 'front-month',
    });
  });

  it('leaves the contract-mix work dir and no repair when the flag is not given', () => {
    const args = parseRecomputeArgs(['--backup', 'b.jsonl']);
    expect(args.repair).toBeUndefined();
    expect(args.workDir).toBe('docs/tmp/futures-derived-recompute');
  });

  it.each([
    ['before', ['--work-dir', 'mine', ...FRONT]],
    ['after', [...FRONT, '--work-dir', 'mine']],
  ])('keeps a --work-dir given %s the flag', (_where, argv) => {
    expect(parseRecomputeArgs(argv).workDir).toBe('mine');
  });

  it('takes --roots, --stores of the three stores and --delete-junk-stale', () => {
    const args = parseRecomputeArgs([
      ...FRONT,
      '--apply',
      '--roots',
      'ES',
      'CL',
      '--stores',
      'snapshots',
      'fires',
      '--expect-snapshots',
      '5',
      '--expect-fires',
      '2',
      '--delete-junk-stale',
      '--expect-junk-deletes',
      '3',
    ]);
    expect(args.repair).toBe('front-month');
    expect(args.roots).toEqual(['ES', 'CL']);
    expect(args.deleteJunkStale).toBe(true);
    expect(args.expectJunkDeletes).toBe(3);
  });

  it.each([
    [
      '--repair contract-mix',
      ['--repair', 'contract-mix', '--backup', 'b'],
      /unknown repair "contract-mix"/,
    ],
    [
      '--repair with no value',
      ['--backup', 'b', '--repair'],
      /--repair needs a value/,
    ],
  ])('refuses %s', (_name, argv, message) => {
    expect(() => parseRecomputeArgs(argv)).toThrow(message);
  });

  it.each([
    [
      '--rewrite-stale-at-write',
      ['--apply', '--rewrite-stale-at-write', '--expect-stale-rewrites', '1'],
    ],
    ['--detector-days', ['--detector-days', 'days.json']],
    ['--stores frozen', ['--stores', 'frozen']],
    [
      '--delete-frozen-stale',
      ['--apply', '--delete-frozen-stale', '--expect-frozen-deletes', '1'],
    ],
    ['--stores volume-null', ['--stores', 'volume-null']],
    [
      '--null-volume-ratio',
      ['--apply', '--null-volume-ratio', '--expect-volume-nulls', '1'],
    ],
  ])('refuses %s', (flag, extra) => {
    const named = new RegExp(
      `${flag.replaceAll('-', '\\-')} does not apply with --repair front-month`,
    );
    expect(() => parseRecomputeArgs([...FRONT, ...extra])).toThrow(named);
    // The same arguments are accepted without the profile (or fail for another reason).
    expect(() => parseRecomputeArgs([...extra, '--backup', 'b'])).not.toThrow(
      named,
    );
  });

  it('refuses a flag of the April to June repair given before --repair too', () => {
    expect(() =>
      parseRecomputeArgs(['--detector-days', 'd.json', ...FRONT]),
    ).toThrow(/--detector-days does not apply with --repair front-month/);
  });

  it('needs the backup for the fires store, which the contract-mix repair does not', () => {
    expect(() => parseRecomputeArgs(['--stores', 'fires'])).not.toThrow();
    expect(() =>
      parseRecomputeArgs(['--repair', 'front-month', '--stores', 'fires']),
    ).toThrow(/--backup <file> is required/);
    expect(
      parseRecomputeArgs([
        '--repair',
        'front-month',
        '--stores',
        'fires',
        '--backup',
        'b.jsonl',
      ]).stores,
    ).toEqual(['fires']);
  });
});

// ── Scope ───────────────────────────────────────────────────────────────────

describe('the front-month scope', () => {
  it('runs the snapshot scope from the span start to the end of the write run, and the fire range to the span end + 6 minutes', () => {
    const { snapshots, fires } = scopeRanges('front-month');
    expect(snapshots).toEqual({
      fromMs: ms('2026-07-28T00:00:00Z'),
      toMs: ms('2026-11-13T05:16:00Z'),
    });
    expect(fires).toEqual({
      fromMs: ms('2026-07-28T00:00:00Z'),
      toMs: ms('2026-11-12T00:06:00Z'),
    });
  });

  it('is still the contract-mix scope without the profile', () => {
    expect(scopeRanges()).toEqual({
      snapshots: {
        fromMs: SPAN.startMs,
        toMs: SPAN.endMs + SNAPSHOT_LOOKBACK_MS,
      },
      fires: { fromMs: SPAN.startMs, toMs: SPAN.endMs + BASIS_LOOKBACK_MS },
    });
  });

  it.each([
    ['2026-07-27', false],
    ['2026-07-28', true],
    ['2026-08-06', true],
    ['2026-11-12', true],
    ['2026-11-13', false],
  ])('premarketInScope(%s) is %s under the profile', (date, inScope) => {
    expect(premarketInScope(date, 'front-month')).toBe(inScope);
  });

  it('keeps the contract-mix answer without the profile', () => {
    expect(premarketInScope('2026-08-06')).toBe(false);
    expect(premarketInScope('2026-05-14')).toBe(true);
    expect(premarketInScope('2026-05-14', 'front-month')).toBe(false);
  });
});

// ── The control set-aside ───────────────────────────────────────────────────

describe('setAsideControl', () => {
  const to = {
    price: 1,
    change1hPct: 2,
    changeDayPct: 3,
    volumeRatio: 4,
  };
  const change = (...fields: SnapshotField[]): SnapshotOutcome => ({
    kind: 'change',
    fields,
    to,
  });
  const none = new Set<SnapshotField>();

  it('changes nothing when no field is affected, whatever the outcome', () => {
    for (const outcome of [
      change('price', 'volumeRatio'),
      { kind: 'same' } as SnapshotOutcome,
      {
        kind: 'unrecomputable',
        why: 'stale (latest bar 20 min old)',
      } as SnapshotOutcome,
    ]) {
      const out = setAsideControl(outcome, none);
      expect(out.outcome).toBe(outcome);
      expect(out.aside).toEqual([]);
    }
  });

  it.each([
    [
      'takes the affected field out and keeps the rest',
      change('price', 'volumeRatio'),
      ['volumeRatio'],
      change('price'),
      ['volumeRatio'],
    ],
    [
      'matches when every differing field is affected',
      change('change1hPct', 'volumeRatio'),
      ['change1hPct', 'volumeRatio', 'price'],
      { kind: 'same' },
      ['change1hPct', 'volumeRatio'],
    ],
    [
      'leaves a difference in a field nothing repaired feeds',
      change('price'),
      ['volumeRatio'],
      change('price'),
      [],
    ],
    [
      'leaves a row that cannot be recomputed as it is',
      { kind: 'unrecomputable', why: 'missing' },
      ['price', 'volumeRatio'],
      { kind: 'unrecomputable', why: 'missing' },
      [],
    ],
    [
      'leaves a matching row as it is',
      { kind: 'same' },
      ['price'],
      { kind: 'same' },
      [],
    ],
  ] satisfies [
    string,
    SnapshotOutcome,
    SnapshotField[],
    SnapshotOutcome,
    SnapshotField[],
  ][])('%s', (_name, outcome, affected, expected, aside) => {
    const out = setAsideControl(outcome, new Set(affected));
    expect(out.outcome).toEqual(expected);
    expect(out.aside).toEqual(aside);
  });
});

// ── Refused before any database read ────────────────────────────────────────

describe('runRecompute --repair front-month, before any database read', () => {
  let work: string;
  beforeEach(() => {
    // A Saturday, so a market-hours check cannot decide these.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    work = mkdtempSync(join(tmpdir(), 'front-month-run-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getDb).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });

  const options = (backup: string): RecomputeOptions => ({
    workDir: join(work, 'out'),
    apply: false,
    force: false,
    stores: ['snapshots', 'premarket', 'fires'],
    roots: ['ES', 'NQ', 'ZN', 'RTY', 'CL', 'GC'],
    repair: 'front-month',
    frozen: false,
    volumeNull: false,
    backup,
    expectSnapshots: null,
    expectPremarket: null,
    expectFires: null,
    deleteJunkStale: false,
    expectJunkDeletes: null,
    rewriteStaleAtWrite: false,
    expectStaleRewrites: null,
    deleteFrozenStale: false,
    expectFrozenDeletes: null,
    nullVolumeRatio: false,
    expectVolumeNulls: null,
    detectorDays: null,
  });
  const errors = (): string =>
    vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');

  it.each([
    [
      'a backup of another run',
      JSON.stringify({ runId: 'another', action: 'tag', symbol: 'ES' }),
      /backup\.jsonl:1: runId "another" is not "2026-11-13T05-10-59Z"/,
    ],
    [
      'a Phase 2 backup, which has no action',
      JSON.stringify({
        op: 'update',
        row: { symbol: 'ES', ts: '2026-04-14T14:30:00Z' },
      }),
      /backup\.jsonl:1: runId "undefined" is not/,
    ],
    ['a line that is not JSON', '{oops', /backup\.jsonl:1: not JSON/],
    [
      'an empty file, which is short of every pinned total',
      '',
      /the totals are not the pinned ones: rewrite 0 \(pinned 9411\)/,
    ],
  ])(
    'exits 1 on %s, naming the file, without reading the database',
    async (_name, content, message) => {
      const path = join(work, 'backup.jsonl');
      writeFileSync(path, content);
      expect(await runRecompute(options(path))).toBe(1);
      expect(errors()).toMatch(message);
      expect(getDb).not.toHaveBeenCalled();
    },
  );

  it('exits 1 on a backup that is not there, without reading the database', async () => {
    expect(await runRecompute(options(join(work, 'missing.jsonl')))).toBe(1);
    expect(errors()).toMatch(/ENOENT/);
    expect(getDb).not.toHaveBeenCalled();
  });
});
