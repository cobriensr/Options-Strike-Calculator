// @vitest-environment node

/**
 * Pure and mocked tests for the lottery V2 re-score: the arguments, the plan,
 * the batch writer's chunking and guards, the stop on an unreadable store and
 * the report. The score itself, pinned to the live detector's own computation,
 * is tested with its module (api/__tests__/lottery-flow-rescore.test.ts). The
 * SQL runs for real in lottery-v2-rescore-pglite.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoadLotteryWeights, mockSql } = vi.hoisted(() => ({
  mockLoadLotteryWeights: vi.fn(),
  mockSql: vi.fn(),
}));

// The two modules the run reaches out through: the weights loader (the store)
// and getDb (the database). Neither is reached for real here.
vi.mock('../../api/_lib/lottery-weights-loader.js', () => ({
  loadLotteryWeights: mockLoadLotteryWeights,
}));
vi.mock('../../api/_lib/db.js', () => ({ getDb: vi.fn(() => mockSql) }));

import {
  SEED_WEIGHTS_LIVE_FROM,
  type CandidateRow,
} from '../../api/_lib/lottery-flow-rescore.js';
import { SEED_LOTTERY_WEIGHTS } from '../../api/_lib/lottery-weights-seed.js';
import {
  applyUpdates,
  countScope,
  formatReport,
  parseArgs,
  planRows,
  runRescore,
  type RescoreResult,
  type ScoreUpdate,
} from './lottery-v2-rescore.js';

const SEED_VERSION = 'seed-2026-06-17';
const REFIT_VERSION = 'refit-2026-11-04';

function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: '1',
    date: '2026-11-13',
    underlying_symbol: 'SNDK',
    tod: 'MID',
    dte: 0,
    option_type: 'C',
    trigger_vol_to_oi_window: 0.4,
    gamma_at_trigger: 0.03,
    trigger_ask_pct: 0.8,
    cum_ncp_at_fire: 5_000_000,
    cum_npp_at_fire: 1_000_000,
    score_version: null,
    ...over,
  };
}

describe('parseArgs', () => {
  it('reads --since and defaults to a dry run', () => {
    expect(parseArgs(['--since', '2026-10-29'])).toEqual({
      apply: false,
      since: '2026-10-29',
      envFile: null,
      help: false,
    });
  });

  it('writes only with --apply, and --dry-run says the default aloud', () => {
    expect(parseArgs(['--since', '2026-10-29', '--apply']).apply).toBe(true);
    expect(parseArgs(['--since', '2026-10-29', '--dry-run']).apply).toBe(false);
    expect(() =>
      parseArgs(['--since', '2026-10-29', '--apply', '--dry-run']),
    ).toThrow('--apply and --dry-run contradict');
  });

  it('takes --env-file', () => {
    expect(
      parseArgs(['--since', '2026-10-29', '--env-file', 'x.env']).envFile,
    ).toBe('x.env');
  });

  it('answers --help without a date', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it.each([
    [[], '--since YYYY-MM-DD is required'],
    [['--apply'], '--since YYYY-MM-DD is required'],
    [['--since'], '--since needs a value'],
    [['--since', '--apply'], '--since needs a value'],
    [['--since', 'yesterday'], '--since yesterday is not a YYYY-MM-DD date'],
    [['--since', '2026-02-30'], '--since 2026-02-30 is not a YYYY-MM-DD date'],
    [['--since', '2026-10-29', '--env-file'], '--env-file needs a value'],
    [['--since', '2026-10-29', '--force'], 'unknown argument --force'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('refuses a date from before the seed weights were live, and accepts that first day', () => {
    expect(() => parseArgs(['--since', '2026-09-07'])).toThrow('older weights');
    expect(() => parseArgs(['--since', '2026-01-02'])).toThrow('older weights');
    expect(parseArgs(['--since', SEED_WEIGHTS_LIVE_FROM]).since).toBe(
      SEED_WEIGHTS_LIVE_FROM,
    );
  });
});

describe('planRows', () => {
  it('sorts rows into to-score, stay-NULL and unscorable, and counts the to-score by date and by the tag they hold', () => {
    const plan = planRows(SEED_LOTTERY_WEIGHTS, [
      row({ id: '10', date: '2026-11-12' }),
      row({ id: '11', date: '2026-11-13', score_version: SEED_VERSION }),
      row({ id: '12', date: '2026-11-13' }),
      row({ id: '13', cum_ncp_at_fire: 1, cum_npp_at_fire: 9 }), // against the flow
      row({ id: '14', tod: 'PRE_OPEN' }), // unknown tod
    ]);

    expect(plan.examined).toBe(5);
    expect(plan.updates.map((u) => u.id)).toEqual(['10', '11', '12']);
    expect(plan.updates.every((u) => Number.isInteger(u.score))).toBe(true);
    // The tag each row held is kept, for the write's guard and the undo.
    expect(plan.updates.map((u) => u.previousVersion)).toEqual([
      null,
      SEED_VERSION,
      null,
    ]);
    expect(plan.stayNull).toBe(1);
    expect(plan.unscorable).toBe(1);
    expect(Object.fromEntries(plan.byDate)).toEqual({
      '2026-11-12': 1,
      '2026-11-13': 2,
    });
    expect(plan.byPreviousVersion).toEqual(
      new Map([
        [null, 2],
        [SEED_VERSION, 1],
      ]),
    );
  });

  it('plans nothing for no rows', () => {
    expect(planRows(SEED_LOTTERY_WEIGHTS, [])).toMatchObject({
      examined: 0,
      updates: [],
      stayNull: 0,
      unscorable: 0,
    });
  });
});

describe('applyUpdates', () => {
  const updates = (count: number): ScoreUpdate[] =>
    Array.from({ length: count }, (_, i) => ({
      id: String(i + 1),
      score: 7,
      previousVersion: i % 2 === 0 ? null : SEED_VERSION,
    }));

  // A tagged-template stub that "writes" every id it is given. The binds, in
  // the statement's order: the version to write, then the ids, scores and
  // previous tags, then the version the pointer must name.
  const writes = () =>
    vi.fn(async (_strings: unknown, _version: string, ids: string[]) =>
      ids.map((id) => ({ id })),
    );

  it('writes 500 rows to a statement and returns the rows written', async () => {
    const sql = writes();

    const written = await applyUpdates(
      sql as never,
      updates(1_200),
      REFIT_VERSION,
    );

    expect(written).toBe(1_200);
    expect(sql.mock.calls.map((c) => c[2].length)).toEqual([500, 500, 200]);
    // ids, scores and previous tags travel as parallel arrays of the same
    // length; the version is bound twice, once to write and once to guard on.
    const [, setVersion, ids, scores, previous, guardVersion] = sql.mock
      .calls[0] as unknown as [
      unknown,
      string,
      string[],
      number[],
      Array<string | null>,
      string,
    ];
    expect(scores).toHaveLength(ids.length);
    expect(previous).toEqual(
      ids.map((_, i) => (i % 2 === 0 ? null : SEED_VERSION)),
    );
    expect(ids[0]).toBe('1');
    expect([setVersion, guardVersion]).toEqual([REFIT_VERSION, REFIT_VERSION]);
  });

  it('guards each statement on score IS NULL, the tag the row held and the active pointer, so another writer’s values stay', async () => {
    const sql = writes();

    await applyUpdates(sql as never, updates(1), REFIT_VERSION);

    const text = (sql.mock.calls[0]![0] as unknown as string[])
      .join('${}')
      .replaceAll(/\s+/g, ' ');
    expect(text).toContain('SET score = u.score, score_version = ${}');
    expect(text).toContain('WHERE f.id = u.id AND f.score IS NULL');
    expect(text).toContain(
      'AND f.score_version IS NOT DISTINCT FROM u.previous_version',
    );
    expect(text).toContain("p.name = 'active' AND p.version = ${}");
    expect(text).toContain('unnest(');
  });

  it('counts only the rows the statement returned', async () => {
    const sql = vi.fn(async () => [{ id: '1' }]);

    await expect(
      applyUpdates(sql as never, updates(3), REFIT_VERSION),
    ).resolves.toBe(1);
  });

  it('writes nothing for nothing', async () => {
    const sql = writes();

    await expect(applyUpdates(sql as never, [], REFIT_VERSION)).resolves.toBe(
      0,
    );
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects when a statement fails, and stops at that statement', async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: '1' }])
      .mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      applyUpdates(sql as never, updates(1_200), REFIT_VERSION),
    ).rejects.toThrow('connection lost');
    expect(sql).toHaveBeenCalledTimes(2);
  });
});

describe('runRescore when the weights store cannot be read', () => {
  beforeEach(() => {
    mockLoadLotteryWeights.mockReset();
    mockSql.mockReset();
  });

  // The loader answers a store it cannot read with the seed in both slots and
  // says why in `fallback`. Taking that for the active version would score
  // and tag rows with a version the store never named.
  it.each(['transient', 'error'] as const)(
    'stops on a %s fallback before reading or writing a row, naming the reason',
    async (kind) => {
      mockLoadLotteryWeights.mockResolvedValue({
        active: { version: SEED_VERSION, weights: SEED_LOTTERY_WEIGHTS },
        takeit: { version: SEED_VERSION, weights: SEED_LOTTERY_WEIGHTS },
        fallback: { kind, reason: 'connection lost' },
      });

      await expect(
        runRescore({ apply: true, since: '2026-10-29', undoDir: 'unused' }),
      ).rejects.toThrow(
        `the weights store could not be read (${kind}: connection lost), so the active version is not known. Nothing was read or written.`,
      );
      expect(mockSql).not.toHaveBeenCalled();
    },
  );

  it('lets a loader that rejects through, so the CLI prints it and exits 1', async () => {
    mockLoadLotteryWeights.mockRejectedValue(new Error('loader exploded'));

    await expect(
      runRescore({ apply: false, since: '2026-10-29', undoDir: 'unused' }),
    ).rejects.toThrow('loader exploded');
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('countScope', () => {
  it('maps the one count row to the scope counts', async () => {
    // countScope calls `sql` as a tagged template: (strings, ...values).
    const sql = vi.fn<
      (
        strings: TemplateStringsArray,
        since: string,
      ) => Promise<Array<Record<string, number>>>
    >(async () => [
      { null_score_with_flow: 4, null_score_no_flow: 1, scored: 7 },
    ]);

    await expect(countScope(sql as never, '2026-10-29')).resolves.toEqual({
      nullScoreWithFlow: 4,
      nullScoreNoFlow: 1,
      scored: 7,
    });
    expect(sql.mock.calls[0]![1]).toBe('2026-10-29');
  });

  it('rejects when the count query returns no row, rather than reporting zeros', async () => {
    const sql = vi.fn(async () => []);

    await expect(countScope(sql as never, '2026-10-29')).rejects.toThrow(
      'count query returned no row',
    );
  });

  it('lets a database failure through, so the CLI prints it and exits 1', async () => {
    const sql = vi.fn().mockRejectedValue(new Error('fetch failed'));

    await expect(countScope(sql as never, '2026-10-29')).rejects.toThrow(
      'fetch failed',
    );
  });
});

describe('formatReport', () => {
  const base: RescoreResult = {
    apply: false,
    since: '2026-10-29',
    version: SEED_VERSION,
    before: { nullScoreWithFlow: 51_300, nullScoreNoFlow: 23, scored: 45_512 },
    after: { nullScoreWithFlow: 50_332, nullScoreNoFlow: 23, scored: 46_480 },
    plan: {
      examined: 51_300,
      toScore: 968,
      stayNull: 50_332,
      unscorable: 0,
      byDate: new Map([
        ['2026-11-13', 700],
        ['2026-11-12', 268],
      ]),
      byPreviousVersion: new Map([
        [SEED_VERSION, 68],
        [null, 900],
      ]),
    },
    written: 0,
    undoFile: null,
  };

  it('says a dry run wrote nothing, and labels the after counts as projected', () => {
    const text = formatReport(base);

    expect(text).toContain('DRY RUN: nothing was written');
    expect(text).toContain('After (projected):');
    expect(text).toContain('51,300');
    expect(text).toContain('968');
    // Dates in order, whatever order the map filled in.
    expect(text.indexOf('2026-11-12')).toBeLessThan(text.indexOf('2026-11-13'));
    expect(text).not.toContain('Undo file');
  });

  it('names the version the rows are scored with and tagged with, and the tags they hold now', () => {
    const text = formatReport({ ...base, version: REFIT_VERSION });

    expect(text).toContain(
      `scored with the weights of the active version, ${REFIT_VERSION}, and tagged with it in score_version`,
    );
    expect(text).toContain('Rows to score by the score_version they hold now:');
    // NULL is written as NULL, and the tags are listed in order.
    expect(text).toContain('  NULL  900');
    expect(text).toContain(`  ${SEED_VERSION}  68`);
    expect(text.indexOf('  NULL  900')).toBeLessThan(
      text.indexOf(`  ${SEED_VERSION}  68`),
    );
  });

  it('reports an apply: rows written, the undo file, measured after counts', () => {
    const text = formatReport({
      ...base,
      apply: true,
      written: 968,
      undoFile: 'docs/tmp/lottery-v2-rescore/undo-x.json',
    });

    expect(text).toContain('APPLY: scores were written.');
    expect(text).toContain('After:');
    expect(text).toContain('Rows written: 968');
    expect(text).toContain(
      'Undo file: docs/tmp/lottery-v2-rescore/undo-x.json',
    );
    expect(text).not.toContain('WARNING');
  });

  it('warns when another writer scored some planned rows first', () => {
    const text = formatReport({
      ...base,
      apply: true,
      written: 960,
      undoFile: 'u.json',
    });

    expect(text).toContain(
      'WARNING: 8 planned rows were scored or tagged by another writer',
    );
  });

  const nothingToScore: RescoreResult['plan'] = {
    ...base.plan,
    toScore: 0,
    byDate: new Map(),
    byPreviousVersion: new Map(),
  };

  it('says so when there is nothing to score', () => {
    const text = formatReport({ ...base, plan: nothingToScore });

    expect(text).toContain('Nothing to score.');
    expect(text).not.toContain('Rows to score by fire date');
    expect(text).not.toContain('Rows to score by the score_version');
  });

  it('says so in an apply too, and does not claim scores were written (a second --apply)', () => {
    const text = formatReport({
      ...base,
      apply: true,
      plan: nothingToScore,
      written: 0,
      undoFile: null,
    });

    expect(text).toContain('APPLY: nothing was written.');
    expect(text).not.toContain('scores were written');
    expect(text).toContain('Rows written: 0');
    expect(text).toContain('Nothing to score.');
    expect(text).not.toContain('WARNING');
    expect(text).not.toContain('Undo file');
  });

  it('does not claim scores were written when another writer took every planned row', () => {
    const text = formatReport({
      ...base,
      apply: true,
      written: 0,
      undoFile: 'u.json',
    });

    expect(text).toContain('APPLY: nothing was written.');
    expect(text).not.toContain('scores were written');
    expect(text).toContain('Rows written: 0');
    expect(text).toContain(
      'WARNING: 968 planned rows were scored or tagged by another writer',
    );
    // Rows were planned, so this is not the "nothing to score" case.
    expect(text).not.toContain('Nothing to score.');
  });
});
