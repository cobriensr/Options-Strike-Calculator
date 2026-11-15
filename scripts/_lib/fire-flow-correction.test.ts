// @vitest-environment node

/**
 * Pure and mocked tests for the doubled-flow correction: the arguments, the
 * judgement of one row, what the score does when the alignment flips (pinned to
 * the live scorer's own computation), the plan's bookkeeping, the batch writer's
 * chunking and direction, the undo file and the report. The SQL runs for real
 * in fire-flow-correction-pglite.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql } = vi.hoisted(() => ({ mockSql: vi.fn() }));

// The two modules the run reaches out through: the weights loader (the store)
// and getDb (the database). Neither is reached for real here.
vi.mock('../../api/_lib/lottery-weights-loader.js', () => ({
  loadLotteryWeights: vi.fn(),
}));
vi.mock('../../api/_lib/db.js', () => ({ getDb: vi.fn(() => mockSql) }));

import {
  scoreLotteryV2,
  weekdayOf,
} from '../../api/_lib/lottery-score-weights-v2.js';
import { SEED_LOTTERY_WEIGHTS } from '../../api/_lib/lottery-weights-seed.js';
import {
  FLOW_TOLERANCE_USD,
  UNDO_NOTE,
  WS_FIRST_DAY,
  alignmentFlip,
  classifyRow,
  formatReport,
  formatUndoReport,
  moveRows,
  parseArgs,
  planScore,
  recordRow,
  runUndo,
  writeUndoFile,
  type Change,
  type CorrectionResult,
  type FireRow,
  type Flow,
  type LegacyAtFire,
  type Plan,
  type Verdict,
} from './fire-flow-correction.js';
import type { CandidateRow } from './lottery-v2-rescore.js';

const SEED = 'seed-2026-06-17';
const REFIT = 'refit-2026-11-04';

// ── parseArgs ───────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('is a dry run when only --since is given', () => {
    expect(parseArgs(['--since', '2026-10-29'])).toEqual({
      apply: false,
      since: '2026-10-29',
      undoFile: null,
      listLimit: 200,
      envFile: null,
      help: false,
    });
  });

  it('reads --apply, --list-limit and --env-file', () => {
    expect(
      parseArgs([
        '--since',
        WS_FIRST_DAY,
        '--apply',
        '--list-limit',
        '0',
        '--env-file',
        'x/.env.local',
      ]),
    ).toMatchObject({
      apply: true,
      since: WS_FIRST_DAY,
      listLimit: 0,
      envFile: 'x/.env.local',
    });
  });

  it('lets --help and --undo-file stand without --since', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['--undo-file', 'f.json', '--apply'])).toMatchObject({
      undoFile: 'f.json',
      apply: true,
      since: null,
    });
  });

  it.each([
    [[], /--since YYYY-MM-DD is required/],
    [['--since', '2026-13-40'], /not a YYYY-MM-DD date/],
    [
      ['--since', '2026-05-03'],
      /before 2026-05-04, the first day the WS flow table has rows/,
    ],
    [['--since', '2026-10-29', '--apply', '--dry-run'], /contradict/],
    [['--since', '2026-10-29', '--undo-file', 'f.json'], /contradict/],
    [['--since', '2026-10-29', '--list-limit', 'x'], /whole number/],
    [['--since'], /--since needs a value/],
    [['--since', '2026-10-29', '--nope'], /unknown argument --nope/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

// ── classifyRow ─────────────────────────────────────────────────────────────

const flow = (ncp: number, npp: number): Flow => ({ ncp, npp });

function legacyOf(
  ws: Flow | null,
  history: Flow | null,
  union: Flow | null,
): LegacyAtFire {
  return { ws, history, union };
}

/** META after the close: WS 175 / 17.5, history 175 / 17.5, legacy union both. */
const BOTH = legacyOf(flow(175, 17.5), flow(175, 17.5), flow(350, 35));

describe('classifyRow', () => {
  it('a stored value equal to the fixed value is correct', () => {
    expect(
      classifyRow({
        stored: flow(175, 17.5),
        fixed: flow(175, 17.5),
        hasWs: true,
        legacy: BOTH,
      }),
    ).toEqual({ kind: 'correct' });
  });

  it('a stored value equal to the doubled value, on a day with WS rows, is doubled and carries the fixed value', () => {
    expect(
      classifyRow({
        stored: flow(350, 35),
        fixed: flow(175, 17.5),
        hasWs: true,
        legacy: BOTH,
      }),
    ).toEqual({ kind: 'doubled', fixed: flow(175, 17.5) });
  });

  it('matches the WS-plus-history sum when a minute-stamp collision made the union smaller', () => {
    // A WS tick on an exact minute stamp merges one pair in the union (343
    // instead of 350); the brief's definition, WS sum plus history sum, still
    // identifies the row.
    const legacy = legacyOf(flow(175, 17.5), flow(175, 17.5), flow(343, 34));
    expect(
      classifyRow({
        stored: flow(350, 35),
        fixed: flow(175, 17.5),
        hasWs: true,
        legacy,
      }).kind,
    ).toBe('doubled');
    // And the union itself, when that is what was stored.
    expect(
      classifyRow({
        stored: flow(343, 34),
        fixed: flow(175, 17.5),
        hasWs: true,
        legacy,
      }).kind,
    ).toBe('doubled');
  });

  it('judges the fixed value first: a row that equals both is correct, not rewritten', () => {
    // History carried nothing before the fire, so doubled equals fixed.
    expect(
      classifyRow({
        stored: flow(175, 17.5),
        fixed: flow(175, 17.5),
        hasWs: true,
        legacy: legacyOf(flow(175, 17.5), null, flow(175, 17.5)),
      }).kind,
    ).toBe('correct');
  });

  it('needs both columns to agree: one doubled column and one fixed column is not doubled', () => {
    expect(
      classifyRow({
        stored: flow(350, 17.5),
        fixed: flow(175, 17.5),
        hasWs: true,
        legacy: BOTH,
      }),
    ).toMatchObject({ kind: 'other', reason: 'unmatched' });
  });

  it('is exact to half a cent: a cent off is a different series', () => {
    expect(FLOW_TOLERANCE_USD).toBe(0.005);
    const base = { fixed: flow(175, 17.5), hasWs: true, legacy: BOTH };
    expect(classifyRow({ stored: flow(175.004, 17.5), ...base }).kind).toBe(
      'correct',
    );
    expect(classifyRow({ stored: flow(175.01, 17.5), ...base })).toMatchObject({
      kind: 'other',
      reason: 'unmatched',
    });
    expect(classifyRow({ stored: flow(350.004, 35), ...base }).kind).toBe(
      'doubled',
    );
    expect(classifyRow({ stored: flow(350.01, 35), ...base }).kind).toBe(
      'other',
    );
  });

  it('a day with no WS rows is never doubled: a history value is listed, not corrected', () => {
    const legacy = legacyOf(null, flow(100, 10), flow(100, 10));
    expect(
      classifyRow({
        stored: flow(100, 10),
        fixed: flow(80, 8),
        hasWs: false,
        legacy,
      }),
    ).toEqual({
      kind: 'other',
      reason: 'history-only-day',
      fixed: flow(80, 8),
    });
  });

  it('a fixed series with no value at the fire is listed, even when the stored value matches a doubled one', () => {
    expect(
      classifyRow({
        stored: flow(350, 35),
        fixed: null,
        hasWs: true,
        legacy: BOTH,
      }),
    ).toEqual({ kind: 'other', reason: 'no-fixed-value', fixed: null });
  });

  it('a value that matches nothing is listed with the fixed value beside it', () => {
    expect(
      classifyRow({
        stored: flow(999, 1),
        fixed: flow(175, 17.5),
        hasWs: true,
        legacy: BOTH,
      }),
    ).toEqual({
      kind: 'other',
      reason: 'unmatched',
      fixed: flow(175, 17.5),
    });
  });
});

// ── the score ───────────────────────────────────────────────────────────────

function candidate(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: '1',
    date: '2026-10-29',
    underlying_symbol: 'META',
    tod: 'MID',
    dte: 0,
    option_type: 'C',
    trigger_vol_to_oi_window: 0.4,
    gamma_at_trigger: 0.03,
    trigger_ask_pct: 0.8,
    cum_ncp_at_fire: 350,
    cum_npp_at_fire: 35,
    score_version: SEED,
    ...over,
  };
}

/** The live detector's own computation for a row, from its columns and its flow. */
function liveScore(row: CandidateRow, ncp: number, npp: number): number | null {
  return scoreLotteryV2(SEED_LOTTERY_WEIGHTS, {
    ticker: row.underlying_symbol,
    tod: row.tod as 'MID',
    dte: row.dte,
    volOiWindow: row.trigger_vol_to_oi_window,
    gammaAtTrigger: row.gamma_at_trigger,
    triggerAskPct: row.trigger_ask_pct,
    optionType: row.option_type,
    isAligned: row.option_type === 'C' ? ncp > npp : npp > ncp,
    dayOfWeek: weekdayOf(row.date),
  });
}

describe('alignmentFlip', () => {
  it.each([
    ['C', flow(350, 35), flow(175, 17.5), null],
    ['C', flow(35, 350), flow(17.5, 175), null],
    ['C', flow(350, 35), flow(100, 190), 'to-unaligned'],
    ['C', flow(35, 350), flow(190, 100), 'to-aligned'],
    ['P', flow(35, 350), flow(190, 100), 'to-unaligned'],
    ['P', flow(350, 35), flow(100, 190), 'to-aligned'],
    // A tie is not aligned either way.
    ['C', flow(5, 5), flow(5, 5), null],
  ] as const)('%s %j to %j: %s', (type, stored, fixed, expected) => {
    expect(alignmentFlip(type, stored, fixed)).toBe(expected);
  });
});

describe('planScore', () => {
  it('leaves the score and its tag alone when the alignment does not change', () => {
    const row = candidate();
    expect(
      planScore(SEED_LOTTERY_WEIGHTS, { row, score: 44 }, flow(175, 17.5)),
    ).toEqual({ kind: 'unchanged' });
    // Not aligned before, not after.
    expect(
      planScore(
        SEED_LOTTERY_WEIGHTS,
        {
          row: candidate({ cum_ncp_at_fire: 10, cum_npp_at_fire: 50 }),
          score: null,
        },
        flow(5, 25),
      ),
    ).toEqual({ kind: 'unchanged' });
  });

  it('nulls the score of a fire that is now against the flow', () => {
    expect(
      planScore(
        SEED_LOTTERY_WEIGHTS,
        { row: candidate(), score: 44 },
        flow(100, 190),
      ),
    ).toEqual({ kind: 'nulled' });
  });

  it('has nothing to null when the score already was NULL', () => {
    expect(
      planScore(
        SEED_LOTTERY_WEIGHTS,
        { row: candidate(), score: null },
        flow(100, 190),
      ),
    ).toEqual({ kind: 'unchanged' });
  });

  it('scores a fire that is now with the flow as the live detector would, with the weights it is given', () => {
    const row = candidate({ cum_ncp_at_fire: 100, cum_npp_at_fire: 290 });
    const expected = liveScore(row, 100, 90);
    expect(expected).toBeTypeOf('number');

    expect(
      planScore(SEED_LOTTERY_WEIGHTS, { row, score: null }, flow(100, 90)),
    ).toEqual({ kind: 'set', score: expected });
  });

  it('does not rewrite a score that already equals what the active weights give', () => {
    const row = candidate({ cum_ncp_at_fire: 100, cum_npp_at_fire: 290 });
    const expected = liveScore(row, 100, 90);
    expect(
      planScore(SEED_LOTTERY_WEIGHTS, { row, score: expected }, flow(100, 90)),
    ).toEqual({ kind: 'unchanged' });
  });

  it('stays NULL for a fire the scorer does not cover (dte outside 0 to 3)', () => {
    const row = candidate({
      dte: 5,
      cum_ncp_at_fire: 100,
      cum_npp_at_fire: 290,
    });
    expect(
      planScore(SEED_LOTTERY_WEIGHTS, { row, score: null }, flow(100, 90)),
    ).toEqual({ kind: 'unchanged' });
  });

  it('leaves a fire with a tod the weights do not know, and says so', () => {
    const row = candidate({
      tod: 'NOT_A_TOD',
      cum_ncp_at_fire: 100,
      cum_npp_at_fire: 290,
    });
    expect(
      planScore(SEED_LOTTERY_WEIGHTS, { row, score: null }, flow(100, 90)),
    ).toEqual({ kind: 'left-unscorable' });
  });

  it.each([
    ['to-aligned', flow(100, 290), flow(100, 90), null],
    ['to-unaligned', flow(350, 35), flow(100, 190), 44],
  ])(
    'never re-scores a fire from before the seed weights were live (%s)',
    (_label, stored, fixed, score) => {
      const row = candidate({
        date: '2026-09-07',
        cum_ncp_at_fire: stored.ncp,
        cum_npp_at_fire: stored.npp,
      });
      expect(planScore(SEED_LOTTERY_WEIGHTS, { row, score }, fixed)).toEqual({
        kind: 'left-pre-seed',
      });
    },
  );

  it('re-scores on the first day the seed weights were live', () => {
    const row = candidate({
      date: '2026-09-08',
      cum_ncp_at_fire: 100,
      cum_npp_at_fire: 290,
    });
    expect(
      planScore(SEED_LOTTERY_WEIGHTS, { row, score: null }, flow(100, 90)).kind,
    ).toBe('set');
  });
});

// ── the plan ────────────────────────────────────────────────────────────────

function emptyPlan(): Plan {
  return {
    scanned: { lottery: 0, silentboom: 0 },
    counts: {
      lottery: { correct: 0, doubled: 0, other: 0 },
      silentboom: { correct: 0, doubled: 0, other: 0 },
    },
    byDate: new Map(),
    otherReasons: new Map(),
    otherRows: [],
    changes: [],
  };
}

function lotteryRow(over: Partial<FireRow> = {}): FireRow {
  return {
    table: 'lottery',
    id: '1',
    date: '2026-10-29',
    ticker: 'META',
    atMs: Date.parse('2026-10-29T14:45:00Z'),
    ncp: '350',
    npp: '35',
    lottery: {
      optionType: 'C',
      tod: 'MID',
      dte: 0,
      volOi: 0.4,
      gamma: 0.03,
      askPct: 0.8,
      score: 44,
      scoreVersion: SEED,
    },
    ...over,
  };
}

const DOUBLED: Verdict = { kind: 'doubled', fixed: flow(175, 17.5) };

function record(
  plan: Plan,
  row: FireRow,
  verdict: Verdict,
  listLimit = 200,
): void {
  recordRow(
    plan,
    row,
    verdict,
    { ncp: Number(row.ncp), npp: Number(row.npp) },
    SEED_LOTTERY_WEIGHTS,
    REFIT,
    listLimit,
  );
}

describe('recordRow', () => {
  it('counts every row by table, date and category', () => {
    const plan = emptyPlan();
    record(plan, lotteryRow({ id: '1' }), { kind: 'correct' });
    record(plan, lotteryRow({ id: '2' }), DOUBLED);
    record(plan, lotteryRow({ id: '3', date: '2026-10-30' }), {
      kind: 'other',
      reason: 'unmatched',
      fixed: null,
    });
    record(
      plan,
      lotteryRow({ id: '4', table: 'silentboom', lottery: null }),
      DOUBLED,
    );

    expect(plan.scanned).toEqual({ lottery: 3, silentboom: 1 });
    expect(plan.counts.lottery).toEqual({ correct: 1, doubled: 1, other: 1 });
    expect(plan.counts.silentboom).toEqual({
      correct: 0,
      doubled: 1,
      other: 0,
    });
    expect(plan.byDate.get('2026-10-29')).toEqual({
      correct: 1,
      doubled: 2,
      other: 0,
    });
    expect(plan.byDate.get('2026-10-30')).toEqual({
      correct: 0,
      doubled: 0,
      other: 1,
    });
    expect(plan.changes.map((c) => c.id)).toEqual(['2', '4']);
  });

  it('lists only the first --list-limit other rows but counts every one', () => {
    const plan = emptyPlan();
    for (let i = 1; i <= 5; i += 1) {
      record(
        plan,
        lotteryRow({ id: String(i) }),
        { kind: 'other', reason: 'history-only-day', fixed: flow(1, 2) },
        2,
      );
    }

    expect(plan.counts.lottery.other).toBe(5);
    expect(plan.otherReasons.get('history-only-day')).toBe(5);
    expect(plan.otherRows.map((r) => r.id)).toEqual(['1', '2']);
    expect(plan.otherRows[0]).toMatchObject({
      reason: 'history-only-day',
      stored: { ncp: 350, npp: 35 },
      fixed: { ncp: 1, npp: 2 },
    });
    expect(plan.changes).toEqual([]);
  });

  it('plans a doubled lottery row whose alignment holds: the flow moves, the score and its tag do not', () => {
    const plan = emptyPlan();
    record(plan, lotteryRow(), DOUBLED);

    expect(plan.changes).toEqual([
      {
        table: 'lottery',
        id: '1',
        date: '2026-10-29',
        ticker: 'META',
        old: { ncp: '350', npp: '35', score: 44, version: SEED },
        new: { ncp: '175', npp: '17.5', score: 44, version: SEED },
        flipped: null,
        score: 'unchanged',
      },
    ]);
  });

  it('plans a flip to against-the-flow: score NULL, tag kept', () => {
    const plan = emptyPlan();
    record(plan, lotteryRow(), { kind: 'doubled', fixed: flow(100, 190) });

    expect(plan.changes[0]).toMatchObject({
      flipped: 'to-unaligned',
      score: 'nulled',
      new: { ncp: '100', npp: '190', score: null, version: SEED },
    });
  });

  it('plans a flip to with-the-flow: the active weights score it and the active version tags it', () => {
    const plan = emptyPlan();
    const row = lotteryRow({
      ncp: '100',
      npp: '290',
      lottery: { ...lotteryRow().lottery!, score: null, scoreVersion: null },
    });
    record(plan, row, { kind: 'doubled', fixed: flow(100, 90) });

    const expected = liveScore(
      candidate({ cum_ncp_at_fire: 100, cum_npp_at_fire: 290 }),
      100,
      90,
    );
    expect(plan.changes[0]).toMatchObject({
      flipped: 'to-aligned',
      score: 'set',
      old: { score: null, version: null },
      new: { ncp: '100', npp: '90', score: expected, version: REFIT },
    });
  });

  it('plans a silent boom row as flow only', () => {
    const plan = emptyPlan();
    record(plan, lotteryRow({ table: 'silentboom', lottery: null }), DOUBLED);

    expect(plan.changes[0]).toMatchObject({
      table: 'silentboom',
      flipped: null,
      score: 'none',
      old: { score: null, version: null },
      new: { ncp: '175', npp: '17.5', score: null, version: null },
    });
  });
});

// ── the writer ──────────────────────────────────────────────────────────────

const row = (id: number): Parameters<typeof moveRows>[2][number] => ({
  table: 'lottery',
  id: String(id),
  old: { ncp: '350', npp: '35', score: 44, version: SEED },
  new: { ncp: '175', npp: '17.5', score: null, version: SEED },
});

describe('moveRows', () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it('writes 500 rows to a statement and counts the rows the database returned', async () => {
    mockSql
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => ({ id: i })))
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => ({ id: i })))
      .mockResolvedValueOnce(
        Array.from({ length: 150 }, (_, i) => ({ id: i })),
      );

    const written = await moveRows(
      mockSql as never,
      'lottery',
      Array.from({ length: 1_150 }, (_, i) => row(i + 1)),
      'apply',
    );

    expect(written).toBe(1_150);
    expect(mockSql).toHaveBeenCalledTimes(3);
    // The ids array of each statement is that chunk.
    expect((mockSql.mock.calls[0]![1] as string[]).length).toBe(500);
    expect((mockSql.mock.calls[2]![1] as string[]).length).toBe(150);
  });

  it('counts a row another writer changed as not written', async () => {
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    expect(
      await moveRows(
        mockSql as never,
        'lottery',
        [row(1), row(2), row(3)],
        'apply',
      ),
    ).toBe(1);
  });

  it('applies old to new, and undoes new to old, guarding on the side it moves from', async () => {
    mockSql.mockResolvedValue([]);
    const rows = [row(7)];

    await moveRows(mockSql as never, 'lottery', rows, 'apply');
    await moveRows(mockSql as never, 'lottery', rows, 'undo');

    // Argument order after the strings: ids, from ncp/npp/score/version,
    // to ncp/npp/score/version, then the direction flag.
    const apply = mockSql.mock.calls[0]!.slice(1);
    const undo = mockSql.mock.calls[1]!.slice(1);
    expect(apply).toEqual([
      ['7'],
      ['350'],
      ['35'],
      [44],
      [SEED],
      ['175'],
      ['17.5'],
      [null],
      [SEED],
      true,
    ]);
    expect(undo).toEqual([
      ['7'],
      ['175'],
      ['17.5'],
      [null],
      [SEED],
      ['350'],
      ['35'],
      [44],
      [SEED],
      false,
    ]);
  });

  it('writes a silent boom row with the two flow columns only', async () => {
    mockSql.mockResolvedValue([{ id: 7 }]);

    await moveRows(
      mockSql as never,
      'silentboom',
      [{ ...row(7), table: 'silentboom' }],
      'apply',
    );

    const sqlText = (mockSql.mock.calls[0]![0] as string[]).join('?');
    expect(sqlText).toContain('UPDATE silent_boom_alerts');
    expect(sqlText).not.toContain('score');
  });

  it('lets a database failure reach the caller', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      moveRows(mockSql as never, 'lottery', [row(1)], 'apply'),
    ).rejects.toThrow('connection lost');
  });
});

// ── the undo file ───────────────────────────────────────────────────────────

describe('the undo file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-undo-'));
    mockSql.mockReset();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const change: Change = {
    table: 'lottery',
    id: '1',
    date: '2026-10-29',
    ticker: 'META',
    old: { ncp: '350', npp: '35', score: 44, version: SEED },
    new: { ncp: '175', npp: '17.5', score: null, version: SEED },
    flipped: 'to-unaligned',
    score: 'nulled',
  };

  it('holds every changed row with its old and new values, and says how to undo', () => {
    const file = writeUndoFile(
      join(dir, 'nested'),
      '2026-10-29',
      [change],
      new Date('2026-11-16T01:02:03.000Z'),
    );

    expect(file).toContain('undo-2026-11-16T01-02-03.000Z.json');
    const body = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(body.note).toBe(UNDO_NOTE);
    expect(body.since).toBe('2026-10-29');
    expect(body.rows).toEqual([
      {
        table: 'lottery',
        id: '1',
        old: { ncp: '350', npp: '35', score: 44, version: SEED },
        new: { ncp: '175', npp: '17.5', score: null, version: SEED },
      },
    ]);
  });

  it('a dry run of the undo only counts the file’s rows and never opens the database', async () => {
    const file = writeUndoFile(dir, '2026-10-29', [change], new Date());

    const result = await runUndo({ file, apply: false });

    expect(result).toEqual({
      apply: false,
      file,
      rows: { lottery: 1, silentboom: 0 },
      restored: { lottery: 0, silentboom: 0 },
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(formatUndoReport(result)).toContain('DRY RUN');
  });

  it('applies the undo through the writer, new to old, and warns about rows that no longer matched', async () => {
    const file = writeUndoFile(
      dir,
      '2026-10-29',
      [change, { ...change, id: '2' }],
      new Date(),
    );
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const result = await runUndo({ file, apply: true });

    expect(result.restored).toEqual({ lottery: 1, silentboom: 0 });
    expect(mockSql.mock.calls[0]!.slice(-1)[0]).toBe(false);
    const report = formatUndoReport(result);
    expect(report).toContain('Rows restored:    lottery 1');
    expect(report).toContain('WARNING: 1 rows no longer held');
  });

  it.each([
    ['not an undo file', '{"rows":[{"table":"nope"}]}'],
    ['not JSON at all', 'rows: []'],
  ])('refuses %s', async (_label, content) => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, content);

    await expect(runUndo({ file, apply: true })).rejects.toThrow();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('names the file when its shape is wrong', async () => {
    const file = join(dir, 'bad.json');
    writeFileSync(
      file,
      '{"note":"x","since":"2026-10-29","rows":[{"table":"nope"}]}',
    );

    await expect(runUndo({ file, apply: false })).rejects.toThrow(
      `${file} is not an undo file from this script`,
    );
  });
});

// ── the report ──────────────────────────────────────────────────────────────

function result(over: Partial<CorrectionResult> = {}): CorrectionResult {
  const plan = emptyPlan();
  plan.scanned = { lottery: 100, silentboom: 10 };
  plan.counts = {
    lottery: { correct: 70, doubled: 25, other: 5 },
    silentboom: { correct: 4, doubled: 5, other: 1 },
  };
  plan.byDate.set('2026-10-29', { correct: 74, doubled: 30, other: 6 });
  plan.otherReasons.set('unmatched', 4);
  plan.otherReasons.set('history-only-day', 2);
  plan.otherRows = [
    {
      table: 'lottery',
      id: '9',
      date: '2026-10-29',
      ticker: 'IWM',
      reason: 'unmatched',
      stored: flow(999, 1),
      fixed: flow(1, 1),
    },
  ];
  return {
    apply: false,
    since: '2026-10-29',
    version: SEED,
    nullFlow: { lottery: 12, silentboom: 1 },
    plan: {
      ...plan,
      toWrite: { lottery: 25, silentboom: 5 },
      score: new Map<Change['score'], number>([
        ['unchanged', 22],
        ['nulled', 2],
        ['set', 1],
      ]),
      toUnaligned: ['11', '12'],
      toAligned: ['13'],
    },
    written: { lottery: 0, silentboom: 0 },
    undoFile: null,
    ...over,
  };
}

describe('formatReport', () => {
  it('a dry run says nothing was written and counts every category per table and date', () => {
    const out = formatReport(result());

    expect(out).toContain('DRY RUN: nothing was written.');
    expect(out).toMatch(/lottery_finder_fires\s+100\s+70\s+25\s+5/);
    expect(out).toMatch(/silent_boom_alerts\s+10\s+4\s+5\s+1/);
    expect(out).toMatch(/2026-10-29\s+74\s+30\s+6/);
    expect(out).toContain('lottery 12, silent boom 1');
    expect(out).toContain('To write: lottery 25, silent boom 5');
  });

  it('lists the alignment flips by id and the score outcomes', () => {
    const out = formatReport(result());

    expect(out).toContain('2 now against the flow, 1 now with it');
    expect(out).toContain('now against the flow: 11, 12');
    expect(out).toContain('now with the flow:    13');
    expect(out).toContain('now against the flow: score set to NULL');
    expect(out).toContain('alignment unchanged: score and tag left');
  });

  it('lists the other rows with the reason, and says how many were not listed', () => {
    const out = formatReport(result());

    expect(out).toContain('Other mismatch (left alone): 6');
    expect(out).toContain(
      'lottery 9 2026-10-29 IWM: stored 999 / 1 (unmatched)',
    );
    expect(out).toContain('... 5 more not listed (--list-limit)');
    expect(out).toContain('history-only day: not doubled');
  });

  it('an apply names the undo file, and warns when fewer rows were written than planned', () => {
    const out = formatReport(
      result({
        apply: true,
        written: { lottery: 20, silentboom: 5 },
        undoFile: 'docs/tmp/fire-flow-correction/undo-x.json',
      }),
    );

    expect(out).toContain('APPLY: corrected values were written.');
    expect(out).toContain('Rows written: lottery 20, silent boom 5');
    expect(out).toContain(
      'WARNING: 5 planned rows were changed by another writer',
    );
    expect(out).toContain(
      'Undo file: docs/tmp/fire-flow-correction/undo-x.json',
    );
  });

  it('an apply that wrote nothing says so, and an empty plan says there is nothing to correct', () => {
    const empty = result({
      apply: true,
      plan: {
        ...result().plan,
        toWrite: { lottery: 0, silentboom: 0 },
        score: new Map(),
        toUnaligned: [],
        toAligned: [],
      },
    });

    const out = formatReport(empty);

    expect(out).toContain('APPLY: nothing was written.');
    expect(out).toContain('Nothing to correct.');
    expect(out).not.toContain('Alignment flips');
  });
});
