// @vitest-environment node

/**
 * Unit tests for the Phase 4 recompute tool: argument parsing, the scope
 * ranges, the control-set rules, the apply gate, the PCS gate-flip list and the
 * market-hours refusal. Everything that touches SQL runs against pglite in
 * futures-derived-recompute-pglite.test.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs';
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
  checkApplyGate,
  compareGlobex,
  compareSnapshot,
  gateFlips,
  parseRecomputeArgs,
  pcsPasses,
  pickControl,
  premarketInScope,
  premarketWindow,
  readOnlyFetch,
  roundNumeric,
  runRecompute,
  scopeRanges,
  type Control,
  type FireChange,
  type SnapshotValues,
} from './futures-derived-recompute.js';

const ms = (iso: string): number => Date.parse(iso);

// ── Arguments ───────────────────────────────────────────────────────────────

describe('parseRecomputeArgs', () => {
  it('defaults to a dry run over all three stores', () => {
    expect(parseRecomputeArgs([])).toEqual({
      workDir: 'docs/tmp/futures-derived-recompute',
      apply: false,
      force: false,
      stores: ['snapshots', 'premarket', 'fires'],
      expectSnapshots: null,
      expectPremarket: null,
      expectFires: null,
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
        '--env-file',
        '.env.test',
        '--force',
      ]),
    ).toEqual({
      workDir: 'out',
      apply: true,
      force: true,
      stores: ['snapshots', 'premarket', 'fires'],
      expectSnapshots: 31012,
      expectPremarket: 36,
      expectFires: 240,
      envFile: '.env.test',
    });
  });

  it('asks only for the expectations of the stores it was given', () => {
    const args = parseRecomputeArgs([
      '--apply',
      '--stores',
      'fires',
      '--expect-fires',
      '12',
    ]);
    expect(args.stores).toEqual(['fires']);
    expect(args.expectFires).toBe(12);
    expect(() =>
      parseRecomputeArgs(['--apply', '--stores', 'fires', 'premarket']),
    ).toThrow(/--apply needs --expect-fires K and --expect-premarket M/);
  });

  it.each([
    [['--bogus'], /unknown argument --bogus/],
    [['--work-dir'], /--work-dir needs a value/],
    [['--env-file'], /--env-file needs a value/],
    [['--stores'], /--stores needs a value/],
    [['--stores', '--apply'], /--stores needs a value/],
    [['--stores', 'bars'], /unknown store "bars"/],
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
  ])('rejects %j', (argv, message) => {
    expect(() => parseRecomputeArgs(argv)).toThrow(message);
  });
});

// ── Scope ───────────────────────────────────────────────────────────────────

describe('scope', () => {
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

// ── Control set ─────────────────────────────────────────────────────────────

describe('pickControl', () => {
  const DAY = 86_400_000;
  /** Rows `step` ms apart, nearest first. */
  const rows = (n: number, step: number): number[] =>
    Array.from({ length: n }, (_, i) => i * step);

  it('takes everything inside 7 days when that is more than 200 rows', () => {
    const near = rows(300, 1000); // 300 rows inside the first 5 minutes
    const far = [8 * DAY, 9 * DAY];
    expect(pickControl([...near, ...far], (x) => x)).toHaveLength(300);
  });

  it('extends to the nearest 200 rows when 7 days hold fewer', () => {
    const near = rows(50, 1000);
    const far = rows(500, DAY).map((x) => x + 8 * DAY);
    const picked = pickControl([...near, ...far], (x) => x);
    expect(picked).toHaveLength(200);
    expect(picked.at(-1)).toBe(far[149]);
  });

  it('takes all of a store that has fewer than 200 rows', () => {
    expect(pickControl(rows(20, DAY), (x) => x)).toHaveLength(20);
    expect(pickControl([], (x: number) => x)).toEqual([]);
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

  it('checks only the stores in the run', () => {
    expect(
      checkApplyGate([store('fires', 7, control(166, 166))], { fires: 7 }),
    ).toEqual([]);
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
    expectSnapshots: 1,
    expectPremarket: 1,
    expectFires: 1,
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
});
