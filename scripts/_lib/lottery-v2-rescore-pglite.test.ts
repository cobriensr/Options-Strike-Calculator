// @vitest-environment node

/**
 * REAL-SQL test for the lottery V2 re-score: the selection, the keyset paging,
 * the active-version rule and the batched UPDATE run against
 * lottery_finder_fires and the weights store built from the REAL migrations in
 * pglite (Postgres in WASM), and the rows are read back. The mocked test
 * (lottery-v2-rescore.test.ts) cannot see a wrong WHERE clause.
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
// The loader logs and alerts when the store can't be read; this test provokes
// that on purpose.
vi.mock('../../api/_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { applyMigration } from '../../api/__tests__/pglite-migrations';
import {
  isAlignedFire,
  scoreLotteryV2,
  weekdayOf,
} from '../../api/_lib/lottery-score-weights-v2.js';
import type { LotteryWeights } from '../../api/_lib/lottery-weights-schema.js';
import {
  SEED_LOTTERY_WEIGHTS,
  SEED_LOTTERY_WEIGHTS_VERSION,
} from '../../api/_lib/lottery-weights-seed.js';
import {
  UNDO_STATEMENT,
  applyUpdates,
  formatReport,
  runRescore,
} from './lottery-v2-rescore.js';
import { getDb } from '../../api/_lib/db.js';

const SINCE = '2026-10-29';
const SEED = SEED_LOTTERY_WEIGHTS_VERSION;
const REFIT = 'refit-2026-11-04';

// A later version's weights: the seed with two weights changed.
const REFIT_WEIGHTS: LotteryWeights = (() => {
  const copy = structuredClone(SEED_LOTTERY_WEIGHTS);
  copy.features.ticker_weights.SNDK =
    (copy.features.ticker_weights.SNDK ?? 0) + 3;
  copy.features.option_type_weights.P += 2;
  return copy;
})();

let pg: PGlite;
let undoDir: string;
// The loader keeps what it read for 60 s of Date.now(). Each run below moves
// the clock past that, so it reads the store as the test left it, as a fresh
// CLI process would. Only Date is faked: pglite's own timers stay real.
let fakeNow = Date.parse('2026-11-14T22:00:00Z');

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fakeNow);
  pg = new PGlite();
  pgRef.current = pg;
  await pg.query("SET TIME ZONE 'America/Chicago'");
  // lottery_finder_fires and what the scored columns need, in order:
  // table, score, silent_boom_alerts (the flow migration alters both),
  // round-trip deduct, flow-at-fire, gamma and the generated combined_score
  // (#167 and #168 build it with the fire-count adjustment, #209 retires that
  // adjustment and rebuilds combined_score without it, as production has it),
  // cluster_bonus; then the weights store, which adds
  // lottery_finder_fires.score_version.
  for (const id of [110, 126, 134, 154, 158, 167, 168, 178, 208, 209]) {
    await applyMigration(pg, id);
  }
}, 120_000);

afterAll(async () => {
  await pg.close();
  pgRef.current = null;
  vi.useRealTimers();
});

/** The store as the migration leaves it: the seed row, both pointers on it. */
async function resetStore(): Promise<void> {
  await pg.exec(`
    DELETE FROM lottery_fire_value_snapshots;
    DELETE FROM lottery_score_pointers;
    DELETE FROM lottery_score_versions;
  `);
  await applyMigration(pg, 208);
}

beforeEach(async () => {
  undoDir = mkdtempSync(join(tmpdir(), 'rescore-undo-'));
  await pg.query('DELETE FROM lottery_finder_fires');
  await resetStore();
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
  scoreVersion?: string | null;
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
       cluster_bonus, score_version)
     VALUES ($1, $2::date, ($2::date + TIME '14:30') AT TIME ZONE 'UTC',
             ($2::date + TIME '14:31') AT TIME ZONE 'UTC', $3,
             $4, $5, 100, '2026-12-31', $6,
             $7, 1, 0.3, 0.3, $8, 10, 3, 1.5, 100, 99,
             1, 'call_ask', $9, 'A_intraday_0DTE', false, false,
             $10, $11, $12, $13, $14, $15)`,
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
      s.scoreVersion ?? null,
    ],
  );
}

/**
 * The score the live detector gives a seeded row under `weights` (its own
 * derivation: scoreLotteryV2 on the row's columns, isAlignedFire on its flow,
 * weekdayOf on its date).
 */
function liveScore(
  s: Required<Pick<Seed, 'date'>> & Seed,
  weights: LotteryWeights = SEED_LOTTERY_WEIGHTS,
): number | null {
  const ncp = s.ncp === undefined ? 5_000_000 : s.ncp;
  const npp = s.npp === undefined ? 1_000_000 : s.npp;
  const optionType = s.optionType ?? 'C';
  return scoreLotteryV2(weights, {
    ticker: s.ticker ?? 'SNDK',
    tod: (s.tod ?? 'MID') as 'MID',
    dte: s.dte ?? 0,
    volOiWindow: s.volOi ?? 0.4,
    gammaAtTrigger: s.gamma === undefined ? 0.03 : s.gamma,
    triggerAskPct: s.askPct ?? 0.8,
    optionType,
    isAligned: isAlignedFire(optionType, ncp, npp),
    dayOfWeek: weekdayOf(s.date),
  });
}

/** Every row, every column, as text, so a diff shows any column that moved. */
async function snapshot(): Promise<Record<string, unknown>[]> {
  const result = await pg.query<Record<string, unknown>>(
    `SELECT to_jsonb(f) AS row FROM lottery_finder_fires f ORDER BY id`,
  );
  return result.rows.map((r) => r.row as Record<string, unknown>);
}

/** A row without the columns a re-score is allowed to move. */
function withoutScore(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([k]) => k !== 'score' && k !== 'combined_score' && k !== 'score_version',
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

async function versionOf(id: number): Promise<string | null> {
  const r = await pg.query<{ score_version: string | null }>(
    'SELECT score_version FROM lottery_finder_fires WHERE id = $1',
    [id],
  );
  return r.rows[0]!.score_version;
}

/** A stored version with `weights`, and the `active` pointer moved onto it. */
async function promote(version: string, weights: LotteryWeights) {
  await pg.query(
    `INSERT INTO lottery_score_versions (version, weights, status)
     VALUES ($1, $2::jsonb, 'promoted')`,
    [version, JSON.stringify(weights)],
  );
  await pg.query(
    `UPDATE lottery_score_pointers SET version = $1 WHERE name = 'active'`,
    [version],
  );
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
//   9  aligned, flow set, tagged with another version  -> scored, retagged
//  10  aligned, flow set, already tagged with the active version (the cron
//      wrote it so, with its NULL score)               -> scored, tag kept
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
  { id: 9, date: '2026-11-13', scoreVersion: REFIT },
  { id: 10, date: '2026-11-13', scoreVersion: SEED },
];
const SCORED_IDS = [1, 2, 8, 9, 10];

async function seedFixture(): Promise<void> {
  for (const s of FIXTURE) await seed({ ...s, clusterBonus: s.id % 3 });
}

/** One run, as a fresh process: the loader's cache expired first. */
const run = (apply: boolean) => {
  fakeNow += 61_000;
  vi.setSystemTime(fakeNow);
  return runRescore({ apply, since: SINCE, undoDir });
};

describe('runRescore against lottery_finder_fires', () => {
  it('the fixture rows really are aligned or not, so the cases below mean what they say', () => {
    for (const id of SCORED_IDS) {
      const s = FIXTURE.find((f) => f.id === id)!;
      expect(liveScore(s), `row ${id}`).toBeTypeOf('number');
    }
    expect(liveScore(FIXTURE.find((f) => f.id === 3)!)).toBeNull();
  });

  it('a dry run changes nothing, writes no undo file, and projects the counts and the version', async () => {
    await seedFixture();
    const before = await snapshot();

    const result = await run(false);

    expect(await snapshot()).toEqual(before);
    expect(readdirSync(undoDir)).toEqual([]);
    expect(result).toMatchObject({
      apply: false,
      since: SINCE,
      version: SEED,
      written: 0,
      undoFile: null,
      // Scope: rows 1, 2, 3, 4, 5, 8, 9, 10 (6 is dte 5, 7 is before --since).
      before: { nullScoreWithFlow: 6, nullScoreNoFlow: 1, scored: 1 },
      after: { nullScoreWithFlow: 1, nullScoreNoFlow: 1, scored: 6 },
      plan: { examined: 6, toScore: 5, stayNull: 1, unscorable: 0 },
    });
    expect(Object.fromEntries(result.plan.byDate)).toEqual({
      '2026-11-13': 3,
      '2026-11-12': 1,
      [SINCE]: 1,
    });
    expect(result.plan.byPreviousVersion).toEqual(
      new Map([
        [null, 3],
        [REFIT, 1],
        [SEED, 1],
      ]),
    );
    expect(formatReport(result)).toContain('DRY RUN: nothing was written');
  });

  it('apply scores exactly the NULL-score rows that have flow, with the active version’s score and tag, and touches no other column or row', async () => {
    await seedFixture();
    const before = await snapshot();

    const result = await run(true);

    expect(result.written).toBe(5);
    for (const id of SCORED_IDS) {
      expect(await scoreOf(id), `row ${id}`).toBe(
        liveScore(FIXTURE.find((f) => f.id === id)!),
      );
      // The active version, whatever tag the row held: NULL, another version,
      // or the active one already.
      expect(await versionOf(id), `row ${id}`).toBe(SEED);
    }
    // Everything else is as it was: the against-the-flow row, the row with no
    // flow, the scored row, dte 5 and the earlier day (score and tag both).
    for (const id of [3, 4, 6, 7]) {
      expect(await scoreOf(id)).toBeNull();
      expect(await versionOf(id)).toBeNull();
    }
    expect(await scoreOf(5)).toBe(99);
    expect(await versionOf(5)).toBeNull();
    // Only `score`, `score_version` and the generated combined_score moved,
    // and only on the scored rows: cluster_bonus, flow and the rest did not.
    const after = await snapshot();
    expect(after).toHaveLength(before.length);
    for (const [i, was] of before.entries()) {
      const now = after[i]!;
      const id = Number(was.id);
      if (SCORED_IDS.includes(id)) {
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
      scored: 6,
    });
    expect(result.undoFile).not.toBeNull();
    expect(existsSync(result.undoFile!)).toBe(true);
    // The file holds each planned row with the score this run gives it and
    // the tag it held, not the ids alone: an undo by id would also restore a
    // row some other writer scored since (see the undo tests below).
    const undo = JSON.parse(readFileSync(result.undoFile!, 'utf8'));
    expect(undo).toMatchObject({
      since: SINCE,
      version: SEED,
      rows: [
        {
          id: '1',
          score: liveScore(FIXTURE.find((f) => f.id === 1)!),
          previousVersion: null,
        },
        {
          id: '2',
          score: liveScore(FIXTURE.find((f) => f.id === 2)!),
          previousVersion: null,
        },
        {
          id: '8',
          score: liveScore(FIXTURE.find((f) => f.id === 8)!),
          previousVersion: null,
        },
        {
          id: '9',
          score: liveScore(FIXTURE.find((f) => f.id === 9)!),
          previousVersion: REFIT,
        },
        {
          id: '10',
          score: liveScore(FIXTURE.find((f) => f.id === 10)!),
          previousVersion: SEED,
        },
      ],
    });
    expect(undo).not.toHaveProperty('ids');
    expect(undo.note).toContain(UNDO_STATEMENT);
    expect(formatReport(result)).toContain('Rows written: 5');
  });

  it('scores with the weights of whichever version the active pointer names, and tags with it', async () => {
    await seedFixture();
    await promote(REFIT, REFIT_WEIGHTS);

    const result = await run(true);

    expect(result.version).toBe(REFIT);
    for (const id of SCORED_IDS) {
      const s = FIXTURE.find((f) => f.id === id)!;
      expect(await scoreOf(id), `row ${id}`).toBe(liveScore(s, REFIT_WEIGHTS));
      expect(await versionOf(id), `row ${id}`).toBe(REFIT);
    }
    // The grid is not vacuous: row 1 (a SNDK call) scores differently under
    // the two versions.
    const row1 = FIXTURE.find((f) => f.id === 1)!;
    expect(liveScore(row1, REFIT_WEIGHTS)).not.toBe(liveScore(row1));
    expect(JSON.parse(readFileSync(result.undoFile!, 'utf8')).version).toBe(
      REFIT,
    );
  });

  it('the undo statement restores the score and the tag of the rows this run wrote, and only while they still hold what it gave them', async () => {
    await seedFixture();
    const result = await run(true);
    const { rows, version } = JSON.parse(
      readFileSync(result.undoFile!, 'utf8'),
    ) as {
      version: string;
      rows: Array<{
        id: string;
        score: number;
        previousVersion: string | null;
      }>;
    };
    const scoreOfRow1 = await scoreOf(1);
    const scoreOfRow2 = await scoreOf(2);
    // After this run another writer changes three rows: it re-scores and
    // re-tags row 2 (the nightly refit's promotion, say), re-tags row 1 and
    // leaves its score, and re-scores row 8 and leaves its tag. Row 5 was
    // scored 99 before the run, and is not in the file.
    await pg.query(
      `UPDATE lottery_finder_fires SET score = 77, score_version = '${REFIT}' WHERE id = 2`,
    );
    await pg.query(
      `UPDATE lottery_finder_fires SET score_version = '${REFIT}' WHERE id = 1`,
    );
    await pg.query('UPDATE lottery_finder_fires SET score = 78 WHERE id = 8');

    await pg.query(UNDO_STATEMENT, [
      rows.map((r) => r.id),
      rows.map((r) => r.score),
      rows.map((r) => r.previousVersion),
      version,
    ]);

    // Rows 9 and 10 are back to what they were before the run: NULL, with the
    // other tag and the active tag they held.
    expect(await scoreOf(9)).toBeNull();
    expect(await versionOf(9)).toBe(REFIT);
    expect(await scoreOf(10)).toBeNull();
    expect(await versionOf(10)).toBe(SEED);
    // Row 2 keeps the other writer's score and tag (an undo by id alone would
    // have cleared it).
    expect(await scoreOf(2)).toBe(77);
    expect(await versionOf(2)).toBe(REFIT);
    expect(scoreOfRow2).not.toBe(77);
    // Row 1 still holds the score this run gave it, but not its tag: that is
    // another writer's, so the row is left whole.
    expect(await scoreOf(1)).toBe(scoreOfRow1);
    expect(scoreOfRow1).not.toBeNull();
    expect(await versionOf(1)).toBe(REFIT);
    // Row 8 holds this run's tag, but not its score.
    expect(await scoreOf(8)).toBe(78);
    expect(await versionOf(8)).toBe(SEED);
    // And row 5 was never ours.
    expect(await scoreOf(5)).toBe(99);
  });

  it('the undo statement restores the table exactly when nothing else wrote in between', async () => {
    await seedFixture();
    const before = await snapshot();
    const result = await run(true);
    const { rows, version } = JSON.parse(
      readFileSync(result.undoFile!, 'utf8'),
    ) as {
      version: string;
      rows: Array<{
        id: string;
        score: number;
        previousVersion: string | null;
      }>;
    };

    await pg.query(UNDO_STATEMENT, [
      rows.map((r) => r.id),
      rows.map((r) => r.score),
      rows.map((r) => r.previousVersion),
      version,
    ]);

    expect(await snapshot()).toEqual(before);
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
    // The headline follows the rows written, not the flag, so it must not say
    // that scores were written. Nothing was left to score, and it says that.
    const report = formatReport(second);
    expect(report).toContain('APPLY: nothing was written.');
    expect(report).not.toContain('scores were written');
    expect(report).toContain('Rows written: 0');
    expect(report).toContain('Nothing to score.');
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
    expect(await versionOf(4)).toBe(SEED);
    expect(await scoreOf(1)).toBe(scored);
  });

  it('never overwrites a score or a tag another writer set after the plan was read', async () => {
    await seedFixture();
    // The plan holds rows 1, 5 and 9 as the dry read saw them: 1 and 9 NULL
    // and NULL, 5 NULL. Row 5 was scored 99 since, and row 9 carries a tag
    // (REFIT) the plan did not see.
    const written = await applyUpdates(
      getDb(),
      [
        { id: '1', score: 11, previousVersion: null },
        { id: '5', score: 11, previousVersion: null },
        { id: '9', score: 11, previousVersion: null },
      ],
      SEED,
    );

    expect(written).toBe(1);
    expect(await scoreOf(1)).toBe(11);
    expect(await versionOf(1)).toBe(SEED);
    expect(await scoreOf(5)).toBe(99);
    expect(await versionOf(5)).toBeNull();
    expect(await scoreOf(9)).toBeNull();
    expect(await versionOf(9)).toBe(REFIT);
  });

  it('writes nothing once the active pointer names another version', async () => {
    await seedFixture();
    await promote(REFIT, REFIT_WEIGHTS);

    // A plan made under the seed, written after the promotion.
    const written = await applyUpdates(
      getDb(),
      [{ id: '1', score: 11, previousVersion: null }],
      SEED,
    );

    expect(written).toBe(0);
    expect(await scoreOf(1)).toBeNull();
    expect(await versionOf(1)).toBeNull();
  });

  it('pages past the 5,000-row page and writes in 500-row statements, scoring and tagging every row', async () => {
    // 5,100 aligned fires with flow, so the keyset page boundary and the
    // chunk boundary are both crossed (and the last chunk is partial).
    await insertBulk(5_100);

    const result = await run(true);

    expect(result.plan).toMatchObject({ examined: 5_100, toScore: 5_100 });
    expect(result.written).toBe(5_100);
    const left = await pg.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM lottery_finder_fires WHERE score IS NULL OR score_version IS DISTINCT FROM $1',
      [SEED],
    );
    expect(left.rows[0]!.n).toBe(0);
    // The last row, past both boundaries, got its own dte's live score.
    expect(await scoreOf(5_100)).toBe(
      liveScore({ id: 5_100, date: '2026-11-13', dte: 5_100 % 4 }),
    );
    expect(
      JSON.parse(readFileSync(result.undoFile!, 'utf8')).rows,
    ).toHaveLength(5_100);
  }, 60_000);

  it('stops writing when a promotion moves the pointer in the middle of the run, and says so with the undo file named', async () => {
    // 1,100 rows are three statements (500, 500, 100). A trigger moves the
    // pointer after the first statement writes, as a promotion landing mid-run
    // would, so the next two find the pointer on another version and write
    // nothing.
    await insertBulk(1_100);
    await pg.query(
      `INSERT INTO lottery_score_versions (version, weights, status)
       VALUES ('${REFIT}', $1::jsonb, 'promoted')`,
      [JSON.stringify(REFIT_WEIGHTS)],
    );
    await pg.exec(`
      CREATE FUNCTION move_active_pointer() RETURNS trigger AS $$
      BEGIN
        UPDATE lottery_score_pointers SET version = '${REFIT}' WHERE name = 'active';
        RETURN NULL;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER move_active_pointer_after_write
        AFTER UPDATE ON lottery_finder_fires
        FOR EACH STATEMENT EXECUTE FUNCTION move_active_pointer();
    `);

    const failure = await run(true).then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain(
      `the active pointer moved from ${SEED} to ${REFIT} during the run. 500 of 1,100 planned rows were written under ${SEED}`,
    );
    expect(failure!.message).toContain('undo-');
    const written = await pg.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM lottery_finder_fires WHERE score IS NOT NULL',
    );
    expect(written.rows[0]!.n).toBe(500);
    expect(readdirSync(undoDir)).toHaveLength(1);
    await pg.exec(`
      DROP TRIGGER move_active_pointer_after_write ON lottery_finder_fires;
      DROP FUNCTION move_active_pointer();
    `);
  });

  it.each([
    ['a missing active pointer', `DELETE FROM lottery_score_pointers`],
    [
      'weights that fail validation',
      `UPDATE lottery_score_versions SET weights = '{"schema_version": 1}'::jsonb`,
    ],
  ])(
    'stops with nothing read or written when the store gives %s, rather than scoring with the seed under the active name',
    async (_label, breakStore) => {
      await seedFixture();
      await pg.exec(breakStore);
      const before = await snapshot();

      const failure = await run(true).then(
        () => null,
        (err: unknown) => err as Error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).toContain(
        'the weights store could not be read (error:',
      );
      expect(failure!.message).toContain('Nothing was read or written.');
      expect(await snapshot()).toEqual(before);
      expect(readdirSync(undoDir)).toEqual([]);
    },
  );

  it('rejects with the undo file named when the write fails, and leaves the table as it was (the statement is atomic)', async () => {
    await seedFixture();
    // Row 2's score is refused by the table, so the one statement that holds
    // every scored row fails whole.
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

/** `count` aligned SNDK calls with flow, dte cycling 0-3, ids 1..count. */
async function insertBulk(count: number): Promise<void> {
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
       FROM generate_series(1, $1::int) AS g`,
    [count],
  );
}
