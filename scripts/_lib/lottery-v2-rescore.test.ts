// @vitest-environment node

/**
 * Pure and mocked tests for the lottery V2 re-score: the arguments, the score
 * itself (pinned to the live detector's own computation), the plan, the batch
 * writer's chunking and the report. The SQL runs for real in
 * lottery-v2-rescore-pglite.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import { computeLotteryScoreV2 } from '../../api/_lib/lottery-score-weights-v2.js';
import {
  SEED_WEIGHTS_LIVE_FROM,
  applyUpdates,
  countScope,
  formatReport,
  parseArgs,
  planRows,
  rescoreRow,
  type CandidateRow,
  type RescoreResult,
  type ScoreUpdate,
} from './lottery-v2-rescore.js';

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

// The cron's own computation, copied from detect-lottery-fires.ts Pass 1 on
// purpose: this is what the re-score must stay equal to. If the cron's
// derivation of isAligned or the weekday changes, this copy is the thing to
// update, and the table below then says whether the script follows.
function liveScore(r: CandidateRow): number | null {
  const isAligned =
    r.cum_ncp_at_fire != null &&
    r.cum_npp_at_fire != null &&
    ((r.option_type === 'C' && r.cum_ncp_at_fire > r.cum_npp_at_fire) ||
      (r.option_type === 'P' && r.cum_npp_at_fire > r.cum_ncp_at_fire));
  return computeLotteryScoreV2({
    ticker: r.underlying_symbol,
    tod: r.tod as 'MID',
    dte: r.dte,
    volOiWindow: r.trigger_vol_to_oi_window ?? null,
    gammaAtTrigger: r.gamma_at_trigger ?? null,
    triggerAskPct: r.trigger_ask_pct ?? null,
    optionType: r.option_type,
    isAligned,
    dayOfWeek: new Date(`${r.date}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long',
    }),
  });
}

describe('rescoreRow', () => {
  const tickers = ['SNDK', 'TSLA', 'SPY', 'NVDA', 'NOT_IN_THE_WEIGHTS'];
  const tods = ['AM_open', 'MID', 'LUNCH', 'PM'];
  const dates = [
    '2026-11-09',
    '2026-11-10',
    '2026-11-11',
    '2026-11-12',
    '2026-11-13',
  ];
  const cases: CandidateRow[] = [];
  let seq = 0;
  for (const ticker of tickers) {
    for (const tod of tods) {
      for (const dte of [0, 1, 2, 3, 4]) {
        for (const option_type of ['C', 'P'] as const) {
          seq += 1;
          cases.push(
            row({
              id: String(seq),
              underlying_symbol: ticker,
              tod,
              dte,
              option_type,
              date: dates[seq % dates.length]!,
              // Alternate aligned and against-the-flow, and null features.
              cum_ncp_at_fire: seq % 3 === 0 ? 100 : 5_000_000,
              cum_npp_at_fire: seq % 3 === 0 ? 5_000_000 : 100,
              trigger_vol_to_oi_window: seq % 5 === 0 ? null : (seq % 9) / 3,
              gamma_at_trigger: seq % 7 === 0 ? null : (seq % 11) / 200,
              trigger_ask_pct: seq % 4 === 0 ? null : (seq % 10) / 10,
            }),
          );
        }
      }
    }
  }

  it(`equals the live detector's score on all ${cases.length} rows of a grid`, () => {
    expect(cases.length).toBe(200);
    let scored = 0;
    for (const r of cases) {
      const expected = liveScore(r);
      expect(rescoreRow(r), JSON.stringify(r)).toBe(expected);
      if (expected != null) scored += 1;
    }
    // The grid exercises both outcomes.
    expect(scored).toBeGreaterThan(30);
    expect(scored).toBeLessThan(cases.length);
  });

  it('gives a fire against the flow, and a tie, no score', () => {
    expect(
      rescoreRow(
        row({ option_type: 'C', cum_ncp_at_fire: 1, cum_npp_at_fire: 9 }),
      ),
    ).toBeNull();
    expect(
      rescoreRow(
        row({ option_type: 'P', cum_ncp_at_fire: 9, cum_npp_at_fire: 1 }),
      ),
    ).toBeNull();
    expect(
      rescoreRow(row({ cum_ncp_at_fire: 5, cum_npp_at_fire: 5 })),
    ).toBeNull();
  });

  it('gives dte beyond 3 no score', () => {
    expect(rescoreRow(row({ dte: 4 }))).toBeNull();
  });

  it('reports a tod the weights do not know as unscorable, never NaN', () => {
    expect(rescoreRow(row({ tod: 'PRE_OPEN' }))).toBe('unscorable');
  });
});

describe('planRows', () => {
  it('sorts rows into to-score, stay-NULL and unscorable, and counts the to-score by date', () => {
    const plan = planRows([
      row({ id: '10', date: '2026-11-12' }),
      row({ id: '11', date: '2026-11-13' }),
      row({ id: '12', date: '2026-11-13' }),
      row({ id: '13', cum_ncp_at_fire: 1, cum_npp_at_fire: 9 }), // against the flow
      row({ id: '14', tod: 'PRE_OPEN' }), // unknown tod
    ]);

    expect(plan.examined).toBe(5);
    expect(plan.updates.map((u) => u.id)).toEqual(['10', '11', '12']);
    expect(plan.updates.every((u) => Number.isInteger(u.score))).toBe(true);
    expect(plan.stayNull).toBe(1);
    expect(plan.unscorable).toBe(1);
    expect(Object.fromEntries(plan.byDate)).toEqual({
      '2026-11-12': 1,
      '2026-11-13': 2,
    });
  });

  it('plans nothing for no rows', () => {
    expect(planRows([])).toMatchObject({
      examined: 0,
      updates: [],
      stayNull: 0,
      unscorable: 0,
    });
  });
});

describe('applyUpdates', () => {
  const updates = (count: number): ScoreUpdate[] =>
    Array.from({ length: count }, (_, i) => ({ id: String(i + 1), score: 7 }));

  // A tagged-template stub that "writes" every id it is given.
  const writes = () =>
    vi.fn(async (_strings: unknown, ids: string[]) =>
      ids.map((id) => ({ id })),
    );

  it('writes 500 rows to a statement and returns the rows written', async () => {
    const sql = writes();

    const written = await applyUpdates(sql as never, updates(1_200));

    expect(written).toBe(1_200);
    expect(sql.mock.calls.map((c) => (c[1] as string[]).length)).toEqual([
      500, 500, 200,
    ]);
    // ids and scores travel as parallel arrays of the same length.
    const [, ids, scores] = sql.mock.calls[0] as unknown as [
      unknown,
      string[],
      number[],
    ];
    expect(scores).toHaveLength(ids.length);
    expect(ids[0]).toBe('1');
  });

  it('guards each statement with score IS NULL, so another writer’s score stays', async () => {
    const sql = writes();

    await applyUpdates(sql as never, updates(1));

    const text = (sql.mock.calls[0]![0] as unknown as string[]).join('${}');
    expect(text).toContain('WHERE f.id = u.id AND f.score IS NULL');
    expect(text).toContain('unnest(');
  });

  it('counts only the rows the statement returned', async () => {
    const sql = vi.fn(async () => [{ id: '1' }]);

    await expect(applyUpdates(sql as never, updates(3))).resolves.toBe(1);
  });

  it('writes nothing for nothing', async () => {
    const sql = writes();

    await expect(applyUpdates(sql as never, [])).resolves.toBe(0);
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects when a statement fails, and stops at that statement', async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: '1' }])
      .mockRejectedValueOnce(new Error('connection lost'));

    await expect(applyUpdates(sql as never, updates(1_200))).rejects.toThrow(
      'connection lost',
    );
    expect(sql).toHaveBeenCalledTimes(2);
  });
});

describe('countScope', () => {
  it('maps the one count row to the scope counts', async () => {
    const sql = vi.fn(async () => [
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
      'WARNING: 8 planned rows were scored by another writer',
    );
  });

  it('says so when there is nothing to score', () => {
    const text = formatReport({
      ...base,
      plan: { ...base.plan, toScore: 0, byDate: new Map() },
    });

    expect(text).toContain('Nothing to score.');
    expect(text).not.toContain('Rows to score by fire date');
  });
});
