// @vitest-environment node

/**
 * REAL-SQL test for the lottery V2 re-score: the selection, the keyset paging
 * and the batched UPDATE run against lottery_finder_fires built from the REAL
 * migrations in pglite (Postgres in WASM), and the rows are read back. The
 * mocked test (lottery-v2-rescore.test.ts) cannot see a wrong WHERE clause.
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may depend
 * on the session time zone.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const { pgRef } = vi.hoisted(() => ({
  pgRef: { current: null as PGlite | null },
}));

// getDb() is a Neon-shaped client over pglite; everything else in db.js stays real.
vi.mock('../../api/_lib/db.js', async (importOriginal) => {
  const { neonOverPglite } =
    await import('../../api/__tests__/pglite-migrations');
  return {
    ...(await importOriginal<typeof import('../../api/_lib/db.js')>()),
    getDb: () => {
      const pg = pgRef.current;
      if (!pg) throw new Error('pglite not started');
      return neonOverPglite(pg);
    },
  };
});

import { applyMigration } from '../../api/__tests__/pglite-migrations';
import { computeLotteryScoreV2 } from '../../api/_lib/lottery-score-weights-v2.js';
import {
  applyUpdates,
  formatReport,
  runRescore,
} from './lottery-v2-rescore.js';
import { getDb } from '../../api/_lib/db.js';

const SINCE = '2026-10-29';

let pg: PGlite;
let undoDir: string;

beforeAll(async () => {
  pg = new PGlite();
  pgRef.current = pg;
  await pg.query("SET TIME ZONE 'America/Chicago'");
  // lottery_finder_fires and what the scored columns need, in order:
  // table, score, silent_boom_alerts (the flow migration alters both),
  // round-trip deduct, flow-at-fire, fire-count adjustment, gamma and the
  // generated combined_score, cluster_bonus.
  for (const id of [110, 126, 134, 154, 158, 167, 168, 178]) {
    await applyMigration(pg, id);
  }
}, 120_000);

afterAll(async () => {
  await pg.close();
  pgRef.current = null;
});

beforeEach(async () => {
  undoDir = mkdtempSync(join(tmpdir(), 'rescore-undo-'));
  await pg.query('DELETE FROM lottery_finder_fires');
});

afterEach(() => {
  rmSync(undoDir, { recursive: true, force: true });
});

interface Seed {
  id: number;
  date?: string;
  ticker?: string;
  tod?: string;
  dte?: number;
  optionType?: 'C' | 'P';
  score?: number | null;
  ncp?: number | null;
  npp?: number | null;
  volOi?: number;
  gamma?: number | null;
  askPct?: number;
  clusterBonus?: number;
}

/** One fire, with every NOT NULL column and the columns the re-score reads. */
async function seed(s: Seed): Promise<void> {
  await pg.query(
    `INSERT INTO lottery_finder_fires (
       id, date, trigger_time_ct, entry_time_ct, option_chain_id,
       underlying_symbol, option_type, strike, expiry, dte,
       trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
       trigger_delta, trigger_ask_pct, trigger_window_size,
       trigger_window_prints, entry_price, open_interest, spot_at_first,
       alert_seq, flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged,
       score, cum_ncp_at_fire, cum_npp_at_fire, gamma_at_trigger,
       cluster_bonus)
     VALUES ($1, $2::date, ($2::date + TIME '14:30') AT TIME ZONE 'UTC',
             ($2::date + TIME '14:31') AT TIME ZONE 'UTC', $3,
             $4, $5, 100, '2026-12-31', $6,
             $7, 1, 0.3, 0.3, $8, 10, 3, 1.5, 100, 99,
             1, 'call_ask', $9, 'A_intraday_0DTE', false, false,
             $10, $11, $12, $13, $14)`,
    [
      s.id,
      s.date ?? '2026-11-13',
      `CHAIN${s.id}`,
      s.ticker ?? 'SNDK',
      s.optionType ?? 'C',
      s.dte ?? 0,
      s.volOi ?? 0.4,
      s.askPct ?? 0.8,
      s.tod ?? 'MID',
      s.score ?? null,
      s.ncp === undefined ? 5_000_000 : s.ncp,
      s.npp === undefined ? 1_000_000 : s.npp,
      s.gamma === undefined ? 0.03 : s.gamma,
      s.clusterBonus ?? 0,
    ],
  );
}

/** The score the live detector gives a seeded row (its own derivation). */
function liveScore(s: Required<Pick<Seed, 'date'>> & Seed): number | null {
  const ncp = s.ncp === undefined ? 5_000_000 : s.ncp;
  const npp = s.npp === undefined ? 1_000_000 : s.npp;
  const optionType = s.optionType ?? 'C';
  const isAligned =
    ncp != null &&
    npp != null &&
    ((optionType === 'C' && ncp > npp) || (optionType === 'P' && npp > ncp));
  return computeLotteryScoreV2({
    ticker: s.ticker ?? 'SNDK',
    tod: (s.tod ?? 'MID') as 'MID',
    dte: s.dte ?? 0,
    volOiWindow: s.volOi ?? 0.4,
    gammaAtTrigger: s.gamma === undefined ? 0.03 : s.gamma,
    triggerAskPct: s.askPct ?? 0.8,
    optionType,
    isAligned,
    dayOfWeek: new Date(`${s.date}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long',
    }),
  });
}

/** Every row, every column, as text, so a diff shows any column that moved. */
async function snapshot(): Promise<Record<string, unknown>[]> {
  const result = await pg.query<Record<string, unknown>>(
    `SELECT to_jsonb(f) AS row FROM lottery_finder_fires f ORDER BY id`,
  );
  return result.rows.map((r) => r.row as Record<string, unknown>);
}

/** A row without the two columns a re-score is allowed to move. */
function withoutScore(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([k]) => k !== 'score' && k !== 'combined_score',
    ),
  );
}

async function scoreOf(id: number): Promise<number | null> {
  const r = await pg.query<{ score: number | null }>(
    'SELECT score FROM lottery_finder_fires WHERE id = $1',
    [id],
  );
  return r.rows[0]!.score;
}

// The fixture, one row per rule of the selection:
//   1  aligned call, flow set                          -> scored
//   2  aligned put, flow set, dte 2, an earlier day    -> scored
//   3  call against the flow                           -> stays NULL
//   4  aligned, but flow still NULL (flow backfill not run) -> untouched
//   5  already scored (99)                             -> untouched
//   6  aligned, flow set, dte 5                        -> untouched (out of scope)
//   7  aligned, flow set, before --since               -> untouched
//   8  aligned, flow set, dte 1, on --since itself     -> scored
const FIXTURE: Array<Seed & { date: string }> = [
  { id: 1, date: '2026-11-13' },
  {
    id: 2,
    date: '2026-11-12',
    optionType: 'P',
    ncp: 100,
    npp: 4_000_000,
    dte: 2,
  },
  { id: 3, date: '2026-11-13', ncp: 100, npp: 4_000_000 },
  { id: 4, date: '2026-11-13', ncp: null, npp: null },
  { id: 5, date: '2026-11-13', score: 99 },
  { id: 6, date: '2026-11-13', dte: 5 },
  { id: 7, date: '2026-10-20' },
  { id: 8, date: SINCE, dte: 1, tod: 'PM', ticker: 'TSLA' },
];

async function seedFixture(): Promise<void> {
  for (const s of FIXTURE) await seed({ ...s, clusterBonus: s.id % 3 });
}

const run = (apply: boolean) => runRescore({ apply, since: SINCE, undoDir });

describe('runRescore against lottery_finder_fires', () => {
  it('the fixture rows really are aligned or not, so the cases below mean what they say', () => {
    for (const id of [1, 2, 8]) {
      const s = FIXTURE.find((f) => f.id === id)!;
      expect(liveScore(s), `row ${id}`).toBeTypeOf('number');
    }
    expect(liveScore(FIXTURE.find((f) => f.id === 3)!)).toBeNull();
  });

  it('a dry run changes nothing, writes no undo file, and projects the counts', async () => {
    await seedFixture();
    const before = await snapshot();

    const result = await run(false);

    expect(await snapshot()).toEqual(before);
    expect(readdirSync(undoDir)).toEqual([]);
    expect(result).toMatchObject({
      apply: false,
      since: SINCE,
      written: 0,
      undoFile: null,
      // Scope: rows 1, 2, 3, 4, 5, 8 (6 is dte 5, 7 is before --since).
      before: { nullScoreWithFlow: 4, nullScoreNoFlow: 1, scored: 1 },
      after: { nullScoreWithFlow: 1, nullScoreNoFlow: 1, scored: 4 },
      plan: { examined: 4, toScore: 3, stayNull: 1, unscorable: 0 },
    });
    expect(Object.fromEntries(result.plan.byDate)).toEqual({
      '2026-11-13': 1,
      '2026-11-12': 1,
      [SINCE]: 1,
    });
    expect(formatReport(result)).toContain('DRY RUN: nothing was written');
  });

  it('apply scores exactly the NULL-score rows that have flow, with the live score, and touches no other column or row', async () => {
    await seedFixture();
    const before = await snapshot();

    const result = await run(true);

    expect(result.written).toBe(3);
    for (const id of [1, 2, 8]) {
      expect(await scoreOf(id), `row ${id}`).toBe(
        liveScore(FIXTURE.find((f) => f.id === id)!),
      );
    }
    // Everything else is as it was: the against-the-flow row, the row with no
    // flow, the scored row, dte 5 and the earlier day.
    for (const id of [3, 4, 6, 7]) expect(await scoreOf(id)).toBeNull();
    expect(await scoreOf(5)).toBe(99);
    // Only `score` and the generated combined_score moved, and only on rows
    // 1, 2 and 8: cluster_bonus, flow, score_version and the rest did not.
    const after = await snapshot();
    expect(after).toHaveLength(before.length);
    for (const [i, was] of before.entries()) {
      const now = after[i]!;
      const id = Number(was.id);
      if ([1, 2, 8].includes(id)) {
        expect(withoutScore(now), `row ${id}`).toEqual(withoutScore(was));
        expect(now.score).not.toBeNull();
      } else {
        expect(now, `row ${id}`).toEqual(was);
      }
    }
    // The measured after counts, and the undo file written before the write.
    expect(result.after).toEqual({
      nullScoreWithFlow: 1,
      nullScoreNoFlow: 1,
      scored: 4,
    });
    expect(result.undoFile).not.toBeNull();
    expect(existsSync(result.undoFile!)).toBe(true);
    expect(JSON.parse(readFileSync(result.undoFile!, 'utf8'))).toMatchObject({
      since: SINCE,
      ids: ['1', '2', '8'],
    });
    expect(formatReport(result)).toContain('Rows written: 3');
  });

  it('a second apply selects the same rows, scores them the same way, and writes nothing', async () => {
    await seedFixture();
    await run(true);
    const afterFirst = await snapshot();
    const filesAfterFirst = readdirSync(undoDir);

    const second = await run(true);

    expect(await snapshot()).toEqual(afterFirst);
    expect(second.written).toBe(0);
    expect(second.undoFile).toBeNull();
    expect(readdirSync(undoDir)).toEqual(filesAfterFirst);
    // Row 3 (against the flow) is still examined and still stays NULL.
    expect(second.plan).toMatchObject({
      examined: 1,
      toScore: 0,
      stayNull: 1,
    });
    expect(formatReport(second)).toContain('APPLY: scores were written.');
    expect(formatReport(second)).toContain('Rows written: 0');
  });

  it('picks up a row whose flow was filled after a first run, and leaves the rows the first run scored', async () => {
    await seedFixture();
    await run(true);
    // The flow backfill reaches row 4 (an aligned call) after the first run.
    await pg.query(
      `UPDATE lottery_finder_fires
          SET cum_ncp_at_fire = 5000000, cum_npp_at_fire = 1000000
        WHERE id = 4`,
    );
    const scored = await scoreOf(1);

    const second = await run(true);

    expect(second.written).toBe(1);
    expect(await scoreOf(4)).toBe(liveScore({ id: 4, date: '2026-11-13' }));
    expect(await scoreOf(1)).toBe(scored);
  });

  it('never overwrites a score another writer set after the plan was read', async () => {
    await seedFixture();
    // The plan holds rows 1 and 5; row 5 is already scored 99 by then.
    const written = await applyUpdates(getDb(), [
      { id: '1', score: 11 },
      { id: '5', score: 11 },
    ]);

    expect(written).toBe(1);
    expect(await scoreOf(1)).toBe(11);
    expect(await scoreOf(5)).toBe(99);
  });

  it('pages past the 5,000-row page and writes in 500-row statements, scoring every row', async () => {
    // 5,100 aligned fires with flow, so the keyset page boundary and the
    // chunk boundary are both crossed (and the last chunk is partial).
    await pg.query(
      `INSERT INTO lottery_finder_fires (
         id, date, trigger_time_ct, entry_time_ct, option_chain_id,
         underlying_symbol, option_type, strike, expiry, dte,
         trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
         trigger_delta, trigger_ask_pct, trigger_window_size,
         trigger_window_prints, entry_price, open_interest, spot_at_first,
         alert_seq, flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged,
         cum_ncp_at_fire, cum_npp_at_fire, gamma_at_trigger)
       SELECT g, DATE '2026-11-13',
              TIMESTAMPTZ '2026-11-13 14:30:00+00' + g * INTERVAL '1 second',
              TIMESTAMPTZ '2026-11-13 14:31:00+00', 'BULK' || g,
              'SNDK', 'C', 100, DATE '2026-12-31', (g % 4)::smallint,
              0.4, 1, 0.3, 0.3, 0.8, 10, 3, 1.5, 100, 99,
              1, 'call_ask', 'MID', 'A_intraday_0DTE', false, false,
              5000000, 1000000, 0.03
         FROM generate_series(1, 5100) AS g`,
    );

    const result = await run(true);

    expect(result.plan).toMatchObject({ examined: 5_100, toScore: 5_100 });
    expect(result.written).toBe(5_100);
    const left = await pg.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM lottery_finder_fires WHERE score IS NULL',
    );
    expect(left.rows[0]!.n).toBe(0);
    // The last row, past both boundaries, got its own dte's live score.
    expect(await scoreOf(5_100)).toBe(
      liveScore({ id: 5_100, date: '2026-11-13', dte: 5_100 % 4 }),
    );
    expect(JSON.parse(readFileSync(result.undoFile!, 'utf8')).ids).toHaveLength(
      5_100,
    );
  }, 60_000);

  it('rejects with the undo file named when the write fails, and leaves the table as it was (the statement is atomic)', async () => {
    await seedFixture();
    // Row 2's score is refused by the table, so the one statement that holds
    // rows 1, 2 and 8 fails whole.
    const refused = liveScore(FIXTURE.find((f) => f.id === 2)!)!;
    await pg.query(
      `ALTER TABLE lottery_finder_fires
         ADD CONSTRAINT refuse_row_two CHECK (id <> 2 OR score IS DISTINCT FROM ${refused})`,
    );
    const before = await snapshot();

    const failure = await run(true).then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain('The apply did not complete');
    expect(failure!.message).toContain('undo-');
    expect(await snapshot()).toEqual(before);
    // The undo file was written before the write, so it is there to read.
    expect(readdirSync(undoDir)).toHaveLength(1);
    await pg.query(
      'ALTER TABLE lottery_finder_fires DROP CONSTRAINT refuse_row_two',
    );
  });
});
