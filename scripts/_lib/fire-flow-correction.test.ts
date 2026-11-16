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
  MATERIAL_GAP_FRACTION,
  UNDO_NOTE,
  WS_FIRST_DAY,
  alignmentFlip,
  classifyRow,
  formatReport,
  formatUndoReport,
  gapAtFire,
  gapFlips,
  gapIsMaterial,
  moveRows,
  orderPlanned,
  parseArgs,
  planScore,
  recordRow,
  runUndo,
  summarizeGaps,
  writeUndoFile,
  type Change,
  type CorrectionResult,
  type FireRow,
  type Flow,
  type GapMinute,
  type GapReading,
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

  it('a stored value equal to the WS-only reading is not doubled, even when a doubled candidate equals it too', () => {
    // History carried nothing before the fire, so WS plus history equals the WS
    // sum. The fixed read (an earlier query) saw a different WS total: a tick
    // landed between the two reads. The row holds what the second read holds,
    // so it is not a doubled row, and rewriting it to the stale fixed value
    // would be wrong.
    const legacy = legacyOf(flow(175, 17.5), null, flow(175, 17.5));
    expect(
      classifyRow({
        stored: flow(175, 17.5),
        fixed: flow(180, 18),
        hasWs: true,
        legacy,
      }),
    ).toEqual({ kind: 'other', reason: 'unmatched', fixed: flow(180, 18) });
  });

  describe('look-ahead: a fire before the ticker’s first WS tick', () => {
    // The fixed series has no value there (live stored NULL). The old backfill
    // wrote the unshifted history sum with ts <= fire: the whole first minute.
    const FIRST_MINUTE = flow(-504_732, 99);
    const legacy = legacyOf(null, FIRST_MINUTE, FIRST_MINUTE);

    it('a stored value equal to that history sum, on a day with WS rows, is look-ahead', () => {
      expect(
        classifyRow({
          stored: flow(-504_732, 99),
          fixed: null,
          hasWs: true,
          legacy,
        }),
      ).toEqual({ kind: 'lookahead' });
    });

    it('is exact to half a cent, on both columns', () => {
      const base = { fixed: null, hasWs: true, legacy };
      expect(
        classifyRow({ stored: flow(-504_732.004, 99), ...base }).kind,
      ).toBe('lookahead');
      expect(
        classifyRow({ stored: flow(-504_732.01, 99), ...base }),
      ).toMatchObject({ kind: 'other', reason: 'no-fixed-value' });
      expect(
        classifyRow({ stored: flow(-504_732, 99.01), ...base }),
      ).toMatchObject({ kind: 'other', reason: 'no-fixed-value' });
    });

    it('a stored value that is not the history sum stays other / no-fixed-value', () => {
      expect(
        classifyRow({
          stored: flow(7, 7),
          fixed: null,
          hasWs: true,
          legacy,
        }),
      ).toEqual({ kind: 'other', reason: 'no-fixed-value', fixed: null });
    });

    it('no history row at or before the fire leaves nothing to match', () => {
      expect(
        classifyRow({
          stored: flow(350, 35),
          fixed: null,
          hasWs: true,
          legacy: legacyOf(null, null, null),
        }),
      ).toMatchObject({ kind: 'other', reason: 'no-fixed-value' });
    });

    it('a day with no WS rows is never look-ahead of this kind: it stays no-fixed-value', () => {
      expect(
        classifyRow({
          stored: flow(-504_732, 99),
          fixed: null,
          hasWs: false,
          legacy,
        }),
      ).toEqual({ kind: 'other', reason: 'no-fixed-value', fixed: null });
    });

    it('a fixed value at the fire is judged first: a stored value equal to it is correct, not look-ahead', () => {
      expect(
        classifyRow({
          stored: flow(-504_732, 99),
          fixed: flow(-504_732, 99),
          hasWs: true,
          legacy,
        }),
      ).toEqual({ kind: 'correct' });
    });
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
    // No flow at all (look-ahead rows): never aligned.
    ['C', flow(350, 35), null, 'to-unaligned'],
    ['P', flow(35, 350), null, 'to-unaligned'],
    ['C', flow(35, 350), null, null],
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

  it('never re-scores a fire from before the seed weights were live that is now with the flow', () => {
    const row = candidate({
      date: '2026-09-07',
      cum_ncp_at_fire: 100,
      cum_npp_at_fire: 290,
    });
    expect(
      planScore(SEED_LOTTERY_WEIGHTS, { row, score: null }, flow(100, 90)),
    ).toEqual({ kind: 'left-pre-seed' });
  });

  it('NULLs the score of a pre-seed fire that is now against the flow: NULL needs no weights', () => {
    const row = candidate({ date: '2026-09-07' });
    expect(
      planScore(SEED_LOTTERY_WEIGHTS, { row, score: 44 }, flow(100, 190)),
    ).toEqual({ kind: 'nulled-pre-seed' });
    // Nothing to null when the score already was NULL.
    expect(
      planScore(SEED_LOTTERY_WEIGHTS, { row, score: null }, flow(100, 190)),
    ).toEqual({ kind: 'unchanged' });
  });

  it('treats a missing flow (the look-ahead correction) as not aligned', () => {
    const aligned = candidate();
    expect(
      planScore(SEED_LOTTERY_WEIGHTS, { row: aligned, score: 44 }, null),
    ).toEqual({ kind: 'nulled' });
    expect(
      planScore(
        SEED_LOTTERY_WEIGHTS,
        { row: candidate({ date: '2026-09-07' }), score: 44 },
        null,
      ),
    ).toEqual({ kind: 'nulled-pre-seed' });
    // Not aligned before either: nothing changes.
    expect(
      planScore(
        SEED_LOTTERY_WEIGHTS,
        {
          row: candidate({ cum_ncp_at_fire: 10, cum_npp_at_fire: 50 }),
          score: null,
        },
        null,
      ),
    ).toEqual({ kind: 'unchanged' });
  });

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
      lottery: { correct: 0, doubled: 0, lookahead: 0, other: 0 },
      silentboom: { correct: 0, doubled: 0, lookahead: 0, other: 0 },
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
const LOOKAHEAD: Verdict = { kind: 'lookahead' };

function record(
  plan: Plan,
  row: FireRow,
  verdict: Verdict,
  listLimit = 200,
  gap: GapReading | null = null,
): void {
  recordRow(
    plan,
    {
      row,
      verdict,
      stored: { ncp: Number(row.ncp), npp: Number(row.npp) },
      gap,
    },
    { weights: SEED_LOTTERY_WEIGHTS, activeVersion: REFIT, listLimit },
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
    record(plan, lotteryRow({ id: '5' }), LOOKAHEAD);
    record(
      plan,
      lotteryRow({ id: '6', table: 'silentboom', lottery: null }),
      LOOKAHEAD,
    );

    expect(plan.scanned).toEqual({ lottery: 4, silentboom: 2 });
    expect(plan.counts.lottery).toEqual({
      correct: 1,
      doubled: 1,
      lookahead: 1,
      other: 1,
    });
    expect(plan.counts.silentboom).toEqual({
      correct: 0,
      doubled: 1,
      lookahead: 1,
      other: 0,
    });
    expect(plan.byDate.get('2026-10-29')).toEqual({
      correct: 1,
      doubled: 2,
      lookahead: 2,
      other: 0,
    });
    expect(plan.byDate.get('2026-10-30')).toEqual({
      correct: 0,
      doubled: 0,
      lookahead: 0,
      other: 1,
    });
    expect(plan.changes.map((c) => `${c.category}:${c.id}`)).toEqual([
      'doubled:2',
      'doubled:4',
      'lookahead:5',
      'lookahead:6',
    ]);
    // A look-ahead row is its own category: never one of the "other" reasons.
    expect(plan.otherReasons.size).toBe(1);
    expect(plan.otherRows.map((r) => r.id)).toEqual(['3']);
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
        fireAt: '2026-10-29T14:45:00.000Z',
        category: 'doubled',
        old: { ncp: '350', npp: '35', score: 44, version: SEED },
        new: { ncp: '175', npp: '17.5', score: 44, version: SEED },
        flipped: null,
        score: 'unchanged',
        gap: null,
      },
    ]);
  });

  it('plans a flip to against-the-flow: score NULL, tagged with the active version as live scoring tags it', () => {
    const plan = emptyPlan();
    record(plan, lotteryRow(), { kind: 'doubled', fixed: flow(100, 190) });

    // Live stores a NULL score with `active.version` bound, never the old tag.
    expect(plan.changes[0]).toMatchObject({
      flipped: 'to-unaligned',
      score: 'nulled',
      new: { ncp: '100', npp: '190', score: null, version: REFIT },
    });
  });

  it('plans a pre-seed fire that is now against the flow: score NULL, tag left', () => {
    const plan = emptyPlan();
    const preSeed = lotteryRow({
      date: '2026-09-07',
      lottery: { ...lotteryRow().lottery!, scoreVersion: null },
    });
    record(plan, preSeed, { kind: 'doubled', fixed: flow(100, 190) });

    expect(plan.changes[0]).toMatchObject({
      flipped: 'to-unaligned',
      score: 'nulled-pre-seed',
      old: { score: 44, version: null },
      new: { ncp: '100', npp: '190', score: null, version: null },
    });
  });

  it('plans a pre-seed fire that is now with the flow: flow corrected, score and tag left', () => {
    const plan = emptyPlan();
    const preSeed = lotteryRow({
      date: '2026-09-07',
      ncp: '100',
      npp: '290',
      lottery: { ...lotteryRow().lottery!, score: null, scoreVersion: null },
    });
    record(plan, preSeed, { kind: 'doubled', fixed: flow(100, 90) });

    expect(plan.changes[0]).toMatchObject({
      flipped: 'to-aligned',
      score: 'left-pre-seed',
      new: { ncp: '100', npp: '90', score: null, version: null },
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

  describe('a look-ahead row', () => {
    it('plans a lottery row whose flow goes to NULL: the aligned score is NULLed and tagged with the active version', () => {
      const plan = emptyPlan();
      record(plan, lotteryRow(), LOOKAHEAD);

      expect(plan.changes).toEqual([
        {
          table: 'lottery',
          id: '1',
          date: '2026-10-29',
          ticker: 'META',
          fireAt: '2026-10-29T14:45:00.000Z',
          category: 'lookahead',
          old: { ncp: '350', npp: '35', score: 44, version: SEED },
          new: { ncp: null, npp: null, score: null, version: REFIT },
          flipped: 'to-unaligned',
          score: 'nulled',
          gap: null,
        },
      ]);
    });

    it('leaves a score that already is NULL, and its tag, where it was (not aligned before)', () => {
      const plan = emptyPlan();
      record(
        plan,
        lotteryRow({
          ncp: '35',
          npp: '350',
          lottery: {
            ...lotteryRow().lottery!,
            score: null,
            scoreVersion: null,
          },
        }),
        LOOKAHEAD,
      );

      expect(plan.changes[0]).toMatchObject({
        flipped: null,
        score: 'unchanged',
        new: { ncp: null, npp: null, score: null, version: null },
      });
    });

    it('a pre-seed fire gets the NULL score but keeps its tag', () => {
      const plan = emptyPlan();
      record(
        plan,
        lotteryRow({
          date: '2026-09-01',
          lottery: { ...lotteryRow().lottery!, scoreVersion: null },
        }),
        LOOKAHEAD,
      );

      expect(plan.changes[0]).toMatchObject({
        score: 'nulled-pre-seed',
        old: { score: 44, version: null },
        new: { ncp: null, npp: null, score: null, version: null },
      });
    });

    it('plans a silent boom row as flow only', () => {
      const plan = emptyPlan();
      record(
        plan,
        lotteryRow({ table: 'silentboom', lottery: null }),
        LOOKAHEAD,
      );

      expect(plan.changes[0]).toMatchObject({
        table: 'silentboom',
        category: 'lookahead',
        flipped: null,
        score: 'none',
        new: { ncp: null, npp: null, score: null, version: null },
      });
    });
  });

  describe('the WS gap of a doubled row', () => {
    // 5 history minutes the WS table has no tick for, all put premium. The
    // corrected flow is call 1,000 / put 50: with the gap added the put side
    // wins, so a call fire would stop being aligned.
    const GAP: GapReading = { minutes: 5, ncp: 0, npp: 1_500 };
    const CORRECTED: Verdict = { kind: 'doubled', fixed: flow(1_000, 50) };

    it('keeps the reading with whether it is material and whether a lottery fire would flip', () => {
      const plan = emptyPlan();
      record(
        plan,
        lotteryRow({ ncp: '2000', npp: '1600' }),
        CORRECTED,
        200,
        GAP,
      );

      expect(plan.changes[0]?.gap).toEqual({
        minutes: 5,
        ncp: 0,
        npp: 1_500,
        material: true,
        flips: true,
      });
    });

    it('says nothing about a flip for a gap that is not material, or for a silent boom row', () => {
      const plan = emptyPlan();
      record(plan, lotteryRow({ ncp: '2000', npp: '1600' }), CORRECTED, 200, {
        minutes: 1,
        ncp: 1,
        npp: 0,
      });
      record(
        plan,
        lotteryRow({ table: 'silentboom', lottery: null, id: '2' }),
        CORRECTED,
        200,
        GAP,
      );

      expect(plan.changes[0]?.gap).toMatchObject({
        minutes: 1,
        material: false,
        flips: null,
      });
      expect(plan.changes[1]?.gap).toMatchObject({
        minutes: 5,
        material: true,
        flips: null,
      });
    });

    it('a look-ahead row has no gap reading, whatever it is given', () => {
      const plan = emptyPlan();
      record(plan, lotteryRow(), LOOKAHEAD, 200, GAP);

      expect(plan.changes[0]?.gap).toBeNull();
    });
  });
});

// ── the WS gap ──────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const T1435 = Date.parse('2026-10-29T14:35:00Z');
const gapMinute = (
  offsetMinutes: number,
  ncp: number,
  npp: number,
): GapMinute => ({
  ts: T1435 + offsetMinutes * MINUTE,
  ncp,
  npp,
});

describe('gapAtFire', () => {
  const minutes = [
    gapMinute(0, 0, 300),
    gapMinute(1, 0, 300),
    gapMinute(2, 10, 300),
  ];

  it('sums only the minutes that were complete at the fire', () => {
    // 14:37:30: the 14:35 and 14:36 minutes are complete, 14:37 is not.
    expect(gapAtFire(minutes, T1435 + 2 * MINUTE + 30_000)).toEqual({
      minutes: 2,
      ncp: 0,
      npp: 600,
    });
  });

  it('counts a minute that completes exactly at the fire, not one that completes a millisecond after', () => {
    expect(gapAtFire(minutes, T1435 + 2 * MINUTE).minutes).toBe(2);
    expect(gapAtFire(minutes, T1435 + 2 * MINUTE - 1).minutes).toBe(1);
    expect(gapAtFire(minutes, T1435 + MINUTE - 1).minutes).toBe(0);
  });

  it('reads all of them for a late fire, and none when there are none', () => {
    expect(gapAtFire(minutes, T1435 + 10 * MINUTE)).toEqual({
      minutes: 3,
      ncp: 10,
      npp: 900,
    });
    expect(gapAtFire([], T1435 + 10 * MINUTE)).toEqual({
      minutes: 0,
      ncp: 0,
      npp: 0,
    });
  });
});

describe('gapIsMaterial', () => {
  it('the threshold is 5% of the corrected flow, per side', () => {
    expect(MATERIAL_GAP_FRACTION).toBe(0.05);
  });

  it.each([
    // [gap ncp, gap npp, corrected ncp, corrected npp, material]
    [0, 1_500, 1_000, 50, true],
    // 0.1% of the call side, nothing on the put side.
    [100, 0, 100_000, 10, false],
    // Exactly 5%: not over it.
    [5_000, 0, 100_000, 10, false],
    [5_001, 0, 100_000, 10, true],
    // Material on the smaller side only counts: whichever side.
    [0, 0.6, 100_000, 10, true],
    [0, 0.5, 100_000, 10, false],
    // Signs do not matter.
    [-6_000, 0, -100_000, 5, true],
    // Any gap against a corrected flow of zero is material; no gap never is.
    [1, 0, 0, 0, true],
    [0, 0, 0, 0, false],
  ])(
    'gap %f / %f against corrected %f / %f: %s',
    (gapNcp, gapNpp, ncp, npp, expected) => {
      expect(
        gapIsMaterial({ minutes: 3, ncp: gapNcp, npp: gapNpp }, flow(ncp, npp)),
      ).toBe(expected);
    },
  );
});

describe('gapFlips', () => {
  it.each([
    // [type, corrected, gap, flips]
    ['C', flow(1_000, 50), { ncp: 0, npp: 1_500 }, true],
    ['C', flow(1_000, 50), { ncp: 100, npp: 0 }, false],
    ['P', flow(50, 1_000), { ncp: 1_500, npp: 0 }, true],
    // Not aligned now, aligned once the gap is added.
    ['C', flow(50, 1_000), { ncp: 1_500, npp: 0 }, true],
    ['P', flow(1_000, 50), { ncp: 0, npp: 100 }, false],
  ] as const)('%s %j plus gap %j: %s', (type, corrected, gap, expected) => {
    expect(gapFlips(type, corrected, { minutes: 5, ...gap })).toBe(expected);
  });
});

describe('summarizeGaps', () => {
  function doubledChange(
    id: string,
    table: Change['table'],
    gap: Change['gap'],
    category: Change['category'] = 'doubled',
  ): Change {
    return {
      table,
      id,
      date: '2026-10-29',
      ticker: `T${id}`,
      fireAt: '2026-10-29T14:45:00.000Z',
      category,
      old: { ncp: '2', npp: '2', score: null, version: null },
      new: { ncp: '1000', npp: '50', score: null, version: null },
      flipped: null,
      score: table === 'lottery' ? 'unchanged' : 'none',
      gap,
    };
  }
  const NONE = { minutes: 0, ncp: 0, npp: 0, material: false, flips: null };
  const MINOR = { minutes: 1, ncp: 1, npp: 0, material: false, flips: null };
  const flipping = {
    minutes: 5,
    ncp: 0,
    npp: 1_500,
    material: true,
    flips: true,
  };
  const holding = {
    minutes: 2,
    ncp: 0,
    npp: 600,
    material: true,
    flips: false,
  };
  const silent = { ...holding, flips: null };

  const changes = [
    doubledChange('1', 'lottery', NONE),
    doubledChange('2', 'lottery', MINOR),
    doubledChange('3', 'lottery', flipping),
    doubledChange('4', 'lottery', holding),
    doubledChange('5', 'silentboom', silent),
    doubledChange('6', 'silentboom', NONE),
    // Look-ahead rows are not read for gaps.
    doubledChange('7', 'lottery', null, 'lookahead'),
  ];

  it('counts the doubled rows read, the rows with a gap, the material gaps and the flips', () => {
    const summary = summarizeGaps(changes, 200);

    expect(summary.doubled).toEqual({ lottery: 4, silentboom: 2 });
    expect(summary.withGap).toEqual({ lottery: 3, silentboom: 1 });
    expect(summary.material).toEqual({ lottery: 2, silentboom: 1 });
    expect(summary.flips).toBe(1);
  });

  it('lists the material rows with their corrected flow, up to the limit', () => {
    const summary = summarizeGaps(changes, 2);

    expect(summary.rows).toEqual([
      {
        table: 'lottery',
        id: '3',
        date: '2026-10-29',
        ticker: 'T3',
        minutes: 5,
        gapNcp: 0,
        gapNpp: 1_500,
        ncp: 1_000,
        npp: 50,
        flips: true,
      },
      expect.objectContaining({ table: 'lottery', id: '4', flips: false }),
    ]);
    // The counts stay exact past the cap.
    expect(summary.material).toEqual({ lottery: 2, silentboom: 1 });
    expect(summarizeGaps(changes, 0).rows).toEqual([]);
  });
});

describe('orderPlanned', () => {
  const at = (
    table: Change['table'],
    id: string,
    date: string,
  ): Pick<Change, 'table' | 'id' | 'date'> => ({ table, id, date });
  const make = (pick: Pick<Change, 'table' | 'id' | 'date'>): Change =>
    ({ ...pick, ticker: 'X' }) as Change;
  const changes = [
    make(at('silentboom', '3', '2026-10-30')),
    make(at('lottery', '20', '2026-10-30')),
    make(at('lottery', '9', '2026-10-29')),
    make(at('silentboom', '1', '2026-10-29')),
    make(at('lottery', '100', '2026-10-29')),
  ];

  it('orders by date, then table (lottery first), then numeric id', () => {
    expect(
      orderPlanned(changes).map((c) => `${c.date} ${c.table} ${c.id}`),
    ).toEqual([
      '2026-10-29 lottery 9',
      '2026-10-29 lottery 100',
      '2026-10-29 silentboom 1',
      '2026-10-30 lottery 20',
      '2026-10-30 silentboom 3',
    ]);
  });

  it('does not reorder the plan it is given', () => {
    const before = changes.map((c) => c.id);
    orderPlanned(changes);
    expect(changes.map((c) => c.id)).toEqual(before);
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
    fireAt: '2026-10-29T14:45:00.000Z',
    category: 'doubled',
    old: { ncp: '350', npp: '35', score: 44, version: SEED },
    new: { ncp: '175', npp: '17.5', score: null, version: SEED },
    flipped: 'to-unaligned',
    score: 'nulled',
    gap: null,
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

  it('never overwrites a file that is already there: the first undo file is the only record of its run', () => {
    const now = new Date('2026-11-16T01:02:03.000Z');
    const file = writeUndoFile(dir, '2026-10-29', [change], now);
    const first = readFileSync(file, 'utf8');

    expect(() =>
      writeUndoFile(
        dir,
        '2026-10-30',
        [{ ...change, id: '2' }],
        now, // the same millisecond, so the same file name
      ),
    ).toThrow(expect.objectContaining({ code: 'EEXIST' }));

    expect(readFileSync(file, 'utf8')).toBe(first);
  });

  it('writes a look-ahead row’s NULL flow into the file and reads it back for the undo', async () => {
    const lookahead: Change = {
      ...change,
      category: 'lookahead',
      old: { ncp: '350', npp: '35', score: 44, version: SEED },
      new: { ncp: null, npp: null, score: null, version: REFIT },
    };
    const file = writeUndoFile(dir, '2026-10-29', [lookahead], new Date());
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const result = await runUndo({ file, apply: true });

    expect(result.restored).toEqual({ lottery: 1, silentboom: 0 });
    // Argument order after the strings: ids, from ncp/npp/score/version (the
    // NULLs the correction wrote), to ncp/npp/score/version (the old values).
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([
      ['1'],
      [null],
      [null],
      [null],
      [REFIT],
      ['350'],
      ['35'],
      [44],
      [SEED],
      false,
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

  it('refuses a file that is not an undo file, before touching the database', async () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{"rows":[{"table":"nope"}]}');

    await expect(runUndo({ file, apply: true })).rejects.toThrow(
      `${file} is not an undo file from this script`,
    );
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('names the file and keeps the parse error as the cause when the file is not JSON', async () => {
    const file = join(dir, 'truncated.json');
    writeFileSync(file, '{"note":"x","since":"2026-10-29","rows":[{"tab');

    const failure = await runUndo({ file, apply: true }).then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(failure?.message).toBe(`${file} is not valid JSON`);
    expect(failure?.cause).toBeInstanceOf(SyntaxError);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('lets a missing file say so as itself: it is not a JSON problem', async () => {
    const file = join(dir, 'nope.json');

    await expect(runUndo({ file, apply: false })).rejects.toThrow(/ENOENT/);
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

/** Three planned writes, one of each kind the report words differently. */
const LISTED: Change[] = [
  {
    table: 'lottery',
    id: '11',
    date: '2026-10-29',
    ticker: 'META',
    fireAt: '2026-10-29T14:45:00.000Z',
    category: 'doubled',
    old: { ncp: '350', npp: '35', score: 44, version: SEED },
    new: { ncp: '175', npp: '17.5', score: null, version: REFIT },
    flipped: 'to-unaligned',
    score: 'nulled',
    gap: null,
  },
  {
    table: 'lottery',
    id: '12',
    date: '2026-10-29',
    ticker: 'MU',
    fireAt: '2026-10-29T14:30:00.568Z',
    category: 'lookahead',
    old: { ncp: '-504732.00', npp: '99.50', score: null, version: null },
    new: { ncp: null, npp: null, score: null, version: null },
    flipped: null,
    score: 'unchanged',
    gap: null,
  },
  {
    table: 'silentboom',
    id: '7',
    date: '2026-10-30',
    ticker: 'QQQ',
    fireAt: '2026-10-30T14:30:00.000Z',
    category: 'doubled',
    old: { ncp: '350', npp: '35', score: null, version: null },
    new: { ncp: '175', npp: '17.5', score: null, version: null },
    flipped: null,
    score: 'none',
    gap: null,
  },
];

function result(over: Partial<CorrectionResult> = {}): CorrectionResult {
  const plan = emptyPlan();
  plan.scanned = { lottery: 100, silentboom: 10 };
  plan.counts = {
    lottery: { correct: 67, doubled: 25, lookahead: 3, other: 5 },
    silentboom: { correct: 3, doubled: 5, lookahead: 1, other: 1 },
  };
  plan.byDate.set('2026-10-29', {
    correct: 70,
    doubled: 30,
    lookahead: 4,
    other: 6,
  });
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
      toWrite: { lottery: 28, silentboom: 6 },
      score: new Map<Change['score'], number>([
        ['unchanged', 24],
        ['nulled', 3],
        ['nulled-pre-seed', 1],
        ['set', 1],
        ['left-pre-seed', 1],
      ]),
      toUnaligned: ['11', '12'],
      toAligned: ['13'],
      listedChanges: LISTED,
      gaps: {
        doubled: { lottery: 25, silentboom: 5 },
        withGap: { lottery: 9, silentboom: 2 },
        material: { lottery: 4, silentboom: 1 },
        flips: 2,
        rows: [
          {
            table: 'lottery',
            id: '11',
            date: '2026-10-29',
            ticker: 'META',
            minutes: 5,
            gapNcp: 0,
            gapNpp: 1_500,
            ncp: 1_000,
            npp: 50,
            flips: true,
          },
          {
            table: 'silentboom',
            id: '7',
            date: '2026-10-30',
            ticker: 'QQQ',
            minutes: 2,
            gapNcp: 0,
            gapNpp: 600,
            ncp: 600,
            npp: 10,
            flips: null,
          },
        ],
      },
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
    expect(out).toMatch(/look-ahead/);
    expect(out).toMatch(/lottery_finder_fires\s+100\s+67\s+25\s+3\s+5/);
    expect(out).toMatch(/silent_boom_alerts\s+10\s+3\s+5\s+1\s+1/);
    expect(out).toMatch(/2026-10-29\s+70\s+30\s+4\s+6/);
    expect(out).toContain('lottery 12, silent boom 1');
    expect(out).toContain('To write: lottery 28, silent boom 6');
  });

  it('lists the alignment flips by id and the score outcomes', () => {
    const out = formatReport(result());

    expect(out).toContain('2 now against the flow, 1 now with it');
    expect(out).toContain('now against the flow: 11, 12');
    expect(out).toContain('now with the flow:    13');
    expect(out).toContain(
      'now against the flow: score set to NULL and tagged with the active version',
    );
    expect(out).toContain(
      'fire before 2026-09-08, now against the flow: score set to NULL, tag left',
    );
    expect(out).toContain('alignment unchanged: score and tag left');
  });

  it('lists every planned write with its category, its old and new flow, and for lottery its score and tag', () => {
    const out = formatReport(result());

    expect(out).toContain('Planned writes, fire time in UTC (3 of 34 listed):');
    expect(out).toContain(
      `  lottery 11 2026-10-29 META 14:45:00.000Z doubled: flow 350 / 35 -> 175 / 17.5; score 44 (${SEED}) -> NULL (${REFIT})`,
    );
    expect(out).toContain(
      '  lottery 12 2026-10-29 MU 14:30:00.568Z look-ahead: flow -504732.00 / 99.50 -> NULL / NULL; score NULL (NULL) -> NULL (NULL)',
    );
    // Silent boom has no score to show.
    expect(out).toContain(
      '  silentboom 7 2026-10-30 QQQ 14:30:00.000Z doubled: flow 350 / 35 -> 175 / 17.5\n',
    );
    expect(out).toContain('... 31 more not listed (--list-limit)');
  });

  it('says nothing is listed when the limit is 0, and does not claim more than were planned', () => {
    const none = formatReport(
      result({
        plan: {
          ...result().plan,
          listedChanges: [],
        },
      }),
    );
    expect(none).toContain(
      'Planned writes, fire time in UTC (0 of 34 listed):',
    );
    expect(none).toContain('... 34 more not listed (--list-limit)');

    const all = formatReport(
      result({
        plan: {
          ...result().plan,
          toWrite: { lottery: 2, silentboom: 1 },
        },
      }),
    );
    expect(all).toContain('Planned writes, fire time in UTC (3 of 3 listed):');
    expect(all).not.toContain('... 0 more not listed');
    expect(all).not.toContain('... -');
  });

  it('reports the WS gaps of the doubled rows, the material ones, and the alignment flips they would cause', () => {
    const out = formatReport(result());

    expect(out).toContain('WS gaps');
    expect(out).toContain('owner decision');
    expect(out).toContain('Doubled rows read: lottery 25, silent boom 5');
    expect(out).toContain(
      'with at least one history minute that has no WS tick: lottery 9, silent boom 2',
    );
    expect(out).toContain(
      'material (gap flow over 5% of the corrected flow on either side): lottery 4, silent boom 1',
    );
    expect(out).toContain(
      'material-gap lottery rows whose alignment the gap flow would flip: 2',
    );
    expect(out).toContain(
      '  lottery 11 2026-10-29 META: 5 gap minutes, gap flow 0 / 1,500, corrected 1,000 / 50, flips yes',
    );
    expect(out).toContain(
      '  silentboom 7 2026-10-30 QQQ: 2 gap minutes, gap flow 0 / 600, corrected 600 / 10, flips n/a',
    );
    // 5 material rows in all, 2 listed.
    expect(out).toContain('... 3 more not listed (--list-limit)');
  });

  it('leaves the gap section out when no doubled row was read', () => {
    const out = formatReport(
      result({
        plan: {
          ...result().plan,
          gaps: {
            doubled: { lottery: 0, silentboom: 0 },
            withGap: { lottery: 0, silentboom: 0 },
            material: { lottery: 0, silentboom: 0 },
            flips: 0,
            rows: [],
          },
        },
      }),
    );

    expect(out).not.toContain('WS gaps');
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
        written: { lottery: 23, silentboom: 6 },
        undoFile: 'docs/tmp/fire-flow-correction/undo-x.json',
      }),
    );

    expect(out).toContain('APPLY: corrected values were written.');
    expect(out).toContain('Rows written: lottery 23, silent boom 6');
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
        listedChanges: [],
      },
    });

    const out = formatReport(empty);

    expect(out).toContain('APPLY: nothing was written.');
    expect(out).toContain('Nothing to correct.');
    expect(out).not.toContain('Alignment flips');
    expect(out).not.toContain('Planned writes');
  });
});
