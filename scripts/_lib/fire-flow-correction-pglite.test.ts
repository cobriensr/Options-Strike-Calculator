// @vitest-environment node

/**
 * REAL-SQL test for the doubled-flow correction. The fire tables, the two
 * net-flow tables and the weights store are built from the REAL migrations in
 * pglite (Postgres in WASM); the plan, the batched guarded UPDATE, the undo
 * file and the undo itself run against them and every column is read back.
 * The mocked test (fire-flow-correction.test.ts) cannot see a wrong WHERE
 * clause, a wrong guard or a column the writer was not allowed to move.
 *
 * The fixture is the defect in miniature. META 2026-10-29 holds the same flow
 * at both resolutions (WS ticks with milliseconds, history minutes), so a row
 * written by a post-close reader holds twice the WS-only value. Around it sit
 * the rows the script must leave alone: a value a live run wrote, a value that
 * matches nothing, a history-only day, a fire before the first tick, a fire
 * before --since and a row with no flow.
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may depend
 * on the session time zone.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

const { pgRef, failRef } = vi.hoisted(() => ({
  pgRef: { current: null as PGlite | null },
  failRef: { updates: false },
}));

// getDb() is a Neon-shaped client over pglite; everything else in db.js stays
// real. With `failRef.updates` set, every UPDATE rejects like a lost connection.
vi.mock('../../api/_lib/db.js', async (importOriginal) => {
  const { neonOverPglite } =
    await import('../../api/__tests__/pglite-migrations');
  return {
    ...(await importOriginal<typeof import('../../api/_lib/db.js')>()),
    getDb: () => {
      const pg = pgRef.current;
      if (!pg) throw new Error('pglite not started');
      const real = neonOverPglite(pg);
      if (!failRef.updates) return real;
      const tag = (strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.join('').includes('UPDATE')
          ? Promise.reject(new Error('connection lost'))
          : real(strings, ...values);
      return Object.assign(tag, {
        query: real.query,
        transaction: real.transaction,
      });
    },
  };
});
// The loader logs and alerts when the store can't be read; this test provokes
// that on purpose.
vi.mock('../../api/_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { neonOverPglite } from '../../api/__tests__/pglite-migrations';
import {
  scoreLotteryV2,
  weekdayOf,
} from '../../api/_lib/lottery-score-weights-v2.js';
import type { LotteryWeights } from '../../api/_lib/lottery-weights-schema.js';
import {
  SEED_LOTTERY_WEIGHTS,
  SEED_LOTTERY_WEIGHTS_VERSION,
} from '../../api/_lib/lottery-weights-seed.js';
import {
  buildFireTables,
  clearFireData,
  insertHistoryMinute,
  insertWsTick,
  resetWeightsStore,
  seedLotteryFire,
  seedSilentBoom,
} from './fire-flow-test-helpers';
import {
  moveRows,
  runCorrection,
  runUndo,
  type CorrectionResult,
} from './fire-flow-correction.js';

const SINCE = '2026-09-01';
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
let fakeNow = Date.parse('2026-11-16T22:00:00Z');

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fakeNow);
  pg = new PGlite();
  pgRef.current = pg;
  await pg.query("SET TIME ZONE 'America/Chicago'");
  await buildFireTables(pg);
}, 120_000);

afterAll(async () => {
  await pg.close();
  pgRef.current = null;
  vi.useRealTimers();
});

beforeEach(async () => {
  failRef.updates = false;
  undoDir = mkdtempSync(join(tmpdir(), 'flow-correction-undo-'));
  await clearFireData(pg);
  await resetWeightsStore(pg);
});

afterEach(() => {
  rmSync(undoDir, { recursive: true, force: true });
});

/** A stored version with `weights`, and the `active` pointer moved onto it. */
async function promote(
  version: string,
  weights: LotteryWeights,
): Promise<void> {
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

/** One run, as a fresh process: the loader's cache expired first. */
function run(apply: boolean): Promise<CorrectionResult> {
  fakeNow += 61_000;
  vi.setSystemTime(fakeNow);
  return runCorrection({ apply, since: SINCE, undoDir, listLimit: 200 });
}

async function snapshot(): Promise<Record<string, unknown>[]> {
  const lottery = await pg.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(f) AS row FROM lottery_finder_fires f ORDER BY id`,
  );
  const silent = await pg.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(s) AS row FROM silent_boom_alerts s ORDER BY id`,
  );
  return [...lottery.rows, ...silent.rows].map((r) => r.row);
}

/** Columns a row may differ in after a correction: the four it writes, and the generated score. */
const WRITTEN = [
  'cum_ncp_at_fire',
  'cum_npp_at_fire',
  'score',
  'score_version',
  'combined_score',
];

function withoutWritten(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([k]) => !WRITTEN.includes(k)),
  );
}

async function lotteryRow(id: number) {
  const r = await pg.query<{
    ncp: string | null;
    npp: string | null;
    score: number | null;
    version: string | null;
  }>(
    `SELECT cum_ncp_at_fire::text AS ncp, cum_npp_at_fire::text AS npp,
            score, score_version AS version
       FROM lottery_finder_fires WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

async function silentRow(id: number) {
  const r = await pg.query<{ ncp: string | null; npp: string | null }>(
    `SELECT cum_ncp_at_fire::text AS ncp, cum_npp_at_fire::text AS npp
       FROM silent_boom_alerts WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

const REFIT_SCORE_SNDK = scoreLotteryV2(REFIT_WEIGHTS, {
  ticker: 'SNDK',
  tod: 'MID',
  dte: 0,
  volOiWindow: 0.4,
  gammaAtTrigger: 0.03,
  triggerAskPct: 0.8,
  optionType: 'C',
  isAligned: true,
  dayOfWeek: weekdayOf('2026-10-29'),
});
const SEED_SCORE_SNDK = scoreLotteryV2(SEED_LOTTERY_WEIGHTS, {
  ticker: 'SNDK',
  tod: 'MID',
  dte: 0,
  volOiWindow: 0.4,
  gammaAtTrigger: 0.03,
  triggerAskPct: 0.8,
  optionType: 'C',
  isAligned: true,
  dayOfWeek: weekdayOf('2026-10-29'),
});

/**
 * The fixture, by lottery id (2026-10-29 unless said):
 *   1  META call, doubled 350/35, score 50 (seed)        -> flow only, score kept
 *   2  AAA put, doubled 200/290 (aligned), score 40      -> against the flow: score NULL, tag kept
 *   3  SNDK call, doubled 100/290 (unaligned), no score  -> with the flow: refit score, refit tag
 *   4  META call, live-written 175/17.5                  -> correct, untouched
 *   5  META call, 999/1                                  -> other (matches nothing), untouched
 *   6  IWM call, 150/15 on a history-only day            -> other (look-ahead only), untouched
 *   7  META call before the first tick, 350/35           -> other (no fixed value), untouched
 *   8  CCC call, doubled 100/290, 2026-09-01 (pre-seed)  -> flow corrected, score left
 *   9  DDD call, doubled, 2026-08-31 (before --since)    -> untouched
 *  12  META call, flow NULL                              -> not selected, counted
 * Silent boom: 10 META doubled 350/35 -> corrected; 11 META 175/17.5 -> untouched.
 */
async function seedWorld(): Promise<void> {
  // META: the same 14:30 to 14:31 flow at both resolutions.
  await insertWsTick(pg, 'META', '2026-10-29T14:30:00.984Z', 100, 10);
  await insertWsTick(pg, 'META', '2026-10-29T14:30:31.250Z', 50, 5);
  await insertWsTick(pg, 'META', '2026-10-29T14:31:02.007Z', 25, 2.5);
  await insertHistoryMinute(pg, 'META', '2026-10-29T14:30:00Z', 150, 15);
  await insertHistoryMinute(pg, 'META', '2026-10-29T14:31:00Z', 25, 2.5);
  // AAA and SNDK: the history disagrees with the WS rows, so the doubled value
  // and the true value sit on different sides of the call/put alignment test.
  for (const [ticker, hncp, hnpp] of [
    ['AAA', 100, 200],
    ['SNDK', 0, 200],
  ] as const) {
    await insertWsTick(pg, ticker, '2026-10-29T14:30:00.500Z', 100, 90);
    await insertHistoryMinute(pg, ticker, '2026-10-29T14:30:00Z', hncp, hnpp);
  }
  // IWM: history only.
  await insertHistoryMinute(pg, 'IWM', '2026-10-29T14:30:00Z', 100, 10);
  await insertHistoryMinute(pg, 'IWM', '2026-10-29T14:31:00Z', 50, 5);
  // CCC (2026-09-01) and DDD (2026-08-31): as SNDK.
  await insertWsTick(pg, 'CCC', '2026-09-01T14:30:00.500Z', 100, 90);
  await insertHistoryMinute(pg, 'CCC', '2026-09-01T14:30:00Z', 0, 200);
  await insertWsTick(pg, 'DDD', '2026-08-31T14:30:00.500Z', 100, 90);
  await insertHistoryMinute(pg, 'DDD', '2026-08-31T14:30:00Z', 0, 200);

  const at = '2026-10-29T14:45:00Z';
  const d = '2026-10-29';
  await seedLotteryFire(pg, {
    id: 1,
    date: d,
    at,
    ncp: 350,
    npp: 35,
    score: 50,
    scoreVersion: SEED,
  });
  await seedLotteryFire(pg, {
    id: 2,
    date: d,
    at,
    ticker: 'AAA',
    optionType: 'P',
    ncp: 200,
    npp: 290,
    score: 40,
    scoreVersion: SEED,
  });
  await seedLotteryFire(pg, {
    id: 3,
    date: d,
    at,
    ticker: 'SNDK',
    ncp: 100,
    npp: 290,
  });
  await seedLotteryFire(pg, {
    id: 4,
    date: d,
    at,
    ncp: 175,
    npp: 17.5,
    score: 50,
    scoreVersion: SEED,
  });
  await seedLotteryFire(pg, { id: 5, date: d, at, ncp: 999, npp: 1 });
  await seedLotteryFire(pg, {
    id: 6,
    date: d,
    at: '2026-10-29T14:31:30Z',
    ticker: 'IWM',
    ncp: 150,
    npp: 15,
  });
  await seedLotteryFire(pg, {
    id: 7,
    date: d,
    at: '2026-10-29T13:45:00Z',
    ncp: 350,
    npp: 35,
  });
  await seedLotteryFire(pg, {
    id: 8,
    date: '2026-09-01',
    at: '2026-09-01T14:45:00Z',
    ticker: 'CCC',
    ncp: 100,
    npp: 290,
  });
  await seedLotteryFire(pg, {
    id: 9,
    date: '2026-08-31',
    at: '2026-08-31T14:45:00Z',
    ticker: 'DDD',
    ncp: 100,
    npp: 290,
  });
  await seedLotteryFire(pg, { id: 12, date: d, at, ncp: null, npp: null });
  await seedSilentBoom(pg, { id: 10, date: d, at, ncp: 350, npp: 35 });
  await seedSilentBoom(pg, { id: 11, date: d, at, ncp: 175, npp: 17.5 });
}

describe('runCorrection against the fire tables (real SQL)', () => {
  it('the fixture means what the cases say: the scorer agrees on both sides of each flip', () => {
    expect(SEED_SCORE_SNDK).toBeTypeOf('number');
    expect(REFIT_SCORE_SNDK).toBeTypeOf('number');
    // A promoted version would give a different score for the same fire.
    expect(REFIT_SCORE_SNDK).not.toBe(SEED_SCORE_SNDK);
  });

  it('a dry run changes nothing, writes no undo file, and counts every category', async () => {
    await promote(REFIT, REFIT_WEIGHTS);
    await seedWorld();
    const before = await snapshot();

    const result = await run(false);

    expect(await snapshot()).toEqual(before);
    expect(readdirSync(undoDir)).toEqual([]);
    expect(result.apply).toBe(false);
    expect(result.undoFile).toBeNull();
    expect(result.version).toBe(REFIT);
    expect(result.plan.scanned).toEqual({ lottery: 8, silentboom: 2 });
    expect(result.plan.counts.lottery).toEqual({
      correct: 1,
      doubled: 4,
      other: 3,
    });
    expect(result.plan.counts.silentboom).toEqual({
      correct: 1,
      doubled: 1,
      other: 0,
    });
    expect(result.plan.toWrite).toEqual({ lottery: 4, silentboom: 1 });
    expect(result.nullFlow).toEqual({ lottery: 1, silentboom: 0 });
    expect(result.written).toEqual({ lottery: 0, silentboom: 0 });
    // The score outcome of each corrected lottery row.
    expect(Object.fromEntries(result.plan.score)).toEqual({
      unchanged: 1,
      nulled: 1,
      set: 1,
      'left-pre-seed': 1,
    });
    expect(result.plan.toUnaligned).toEqual(['2']);
    expect(result.plan.toAligned.sort()).toEqual(['3', '8']);
    // The other rows are listed with why.
    expect(result.plan.otherRows.map((r) => [r.id, r.reason]).sort()).toEqual([
      ['5', 'unmatched'],
      ['6', 'history-only-day'],
      ['7', 'no-fixed-value'],
    ]);
    // Row 5's fixed value is the WS-only 175 / 17.5, shown beside the 999 / 1.
    expect(result.plan.otherRows.find((r) => r.id === '5')).toMatchObject({
      stored: { ncp: 999, npp: 1 },
      fixed: { ncp: 175, npp: 17.5 },
    });
  });

  it('an apply moves exactly the doubled rows to the WS-only value and nothing else', async () => {
    await promote(REFIT, REFIT_WEIGHTS);
    await seedWorld();
    const before = await snapshot();

    const result = await run(true);

    expect(result.written).toEqual({ lottery: 4, silentboom: 1 });
    // 1: the flow is WS-only; the alignment held, so the score and tag stay.
    expect(await lotteryRow(1)).toEqual({
      ncp: '175',
      npp: '17.5',
      score: 50,
      version: SEED,
    });
    // 2: now against the flow: NULL, tag kept.
    expect(await lotteryRow(2)).toEqual({
      ncp: '100',
      npp: '90',
      score: null,
      version: SEED,
    });
    // 3: now with the flow: the ACTIVE (refit) weights score it and tag it.
    expect(await lotteryRow(3)).toEqual({
      ncp: '100',
      npp: '90',
      score: REFIT_SCORE_SNDK,
      version: REFIT,
    });
    // 8: before the seed weights were live: flow corrected, score left.
    expect(await lotteryRow(8)).toEqual({
      ncp: '100',
      npp: '90',
      score: null,
      version: null,
    });
    expect(await silentRow(10)).toEqual({ ncp: '175', npp: '17.5' });
    // Everything else is byte for byte what it was: the live-written row, the
    // unmatched row, the history-only row, the pre-tick row, the row before
    // --since, the row with no flow, the untouched silent boom row.
    // The snapshot is the lottery rows by id (1 to 9, then 12), then the silent
    // boom rows (10, 11).
    const after = await snapshot();
    const UNTOUCHED = [3, 4, 5, 6, 8, 9, 11]; // lottery 4, 5, 6, 7, 9, 12; silent boom 11
    const MOVED = [0, 1, 2, 7, 10]; // lottery 1, 2, 3, 8; silent boom 10
    for (const i of UNTOUCHED) {
      expect(after[i], `snapshot row ${i}`).toEqual(before[i]);
    }
    // And on the rows that moved, only the written columns differ.
    for (const i of MOVED) {
      expect(withoutWritten(after[i]!), `snapshot row ${i}`).toEqual(
        withoutWritten(before[i]!),
      );
    }
    expect(result.undoFile).not.toBeNull();
  });

  it('writes the undo file before the first UPDATE, with every changed row old and new', async () => {
    await seedWorld();

    const result = await run(true);

    const files = readdirSync(undoDir);
    expect(files).toHaveLength(1);
    const body = JSON.parse(readFileSync(join(undoDir, files[0]!), 'utf8')) as {
      since: string;
      rows: Array<{
        table: string;
        id: string;
        old: Record<string, unknown>;
        new: Record<string, unknown>;
      }>;
    };
    expect(result.undoFile).toBe(join(undoDir, files[0]!));
    expect(body.since).toBe(SINCE);
    const byId = new Map(body.rows.map((r) => [`${r.table}:${r.id}`, r]));
    expect([...byId.keys()].sort()).toEqual([
      'lottery:1',
      'lottery:2',
      'lottery:3',
      'lottery:8',
      'silentboom:10',
    ]);
    expect(byId.get('lottery:2')).toMatchObject({
      old: { ncp: '200', npp: '290', score: 40, version: SEED },
      new: { ncp: '100', npp: '90', score: null, version: SEED },
    });
  });

  it('a second apply finds nothing doubled, and writes nothing and no second undo file', async () => {
    await seedWorld();
    await run(true);
    const settled = await snapshot();

    const again = await run(true);

    expect(await snapshot()).toEqual(settled);
    expect(again.plan.toWrite).toEqual({ lottery: 0, silentboom: 0 });
    expect(again.plan.counts.lottery.doubled).toBe(0);
    expect(again.written).toEqual({ lottery: 0, silentboom: 0 });
    expect(again.undoFile).toBeNull();
    expect(readdirSync(undoDir)).toHaveLength(1);
  });

  it('the undo file restores every column of every changed row, and only where the row still holds what was written', async () => {
    await promote(REFIT, REFIT_WEIGHTS);
    await seedWorld();
    const before = await snapshot();
    const applied = await run(true);
    expect(await snapshot()).not.toEqual(before);

    const dry = await runUndo({ file: applied.undoFile!, apply: false });
    expect(dry.rows).toEqual({ lottery: 4, silentboom: 1 });
    expect(dry.restored).toEqual({ lottery: 0, silentboom: 0 });

    const undone = await runUndo({ file: applied.undoFile!, apply: true });

    expect(undone.restored).toEqual({ lottery: 4, silentboom: 1 });
    expect(await snapshot()).toEqual(before);
    // A second undo finds no row holding the corrected values.
    const twice = await runUndo({ file: applied.undoFile!, apply: true });
    expect(twice.restored).toEqual({ lottery: 0, silentboom: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('the undo does not overwrite a row another writer has changed since', async () => {
    await seedWorld();
    const applied = await run(true);
    await pg.query(`UPDATE lottery_finder_fires SET score = 77 WHERE id = 1`);
    await pg.query(
      `UPDATE silent_boom_alerts SET cum_ncp_at_fire = 5 WHERE id = 10`,
    );

    const undone = await runUndo({ file: applied.undoFile!, apply: true });

    expect(undone.restored).toEqual({ lottery: 3, silentboom: 0 });
    expect((await lotteryRow(1)).score).toBe(77);
    expect((await silentRow(10)).ncp).toBe('5');
  });

  it('stops before reading or writing anything when the weights store cannot be read', async () => {
    await seedWorld();
    await pg.exec('DELETE FROM lottery_score_pointers');
    const before = await snapshot();

    await expect(run(true)).rejects.toThrow(
      /the weights store could not be read/,
    );

    expect(await snapshot()).toEqual(before);
    expect(readdirSync(undoDir)).toEqual([]);
  });

  it('a failed write surfaces with the undo file named, after the file was written, and a rerun finishes the job', async () => {
    await seedWorld();
    failRef.updates = true;

    const failure = await run(true).then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(failure?.message).toContain('connection lost');
    expect(failure?.message).toContain('The apply did not complete');
    expect(failure?.message).toContain('safe to repeat');
    const files = readdirSync(undoDir);
    expect(files).toHaveLength(1);
    expect(failure?.message).toContain(join(undoDir, files[0]!));
    // Nothing was written, so the doubled rows are still doubled.
    expect((await lotteryRow(1)).ncp).toBe('350');

    failRef.updates = false;
    const rerun = await run(true);
    expect(rerun.written).toEqual({ lottery: 4, silentboom: 1 });
    expect((await lotteryRow(1)).ncp).toBe('175');
  });

  it('reads the dates in scope only: a row before --since is never looked at', async () => {
    await seedWorld();

    const result = await run(false);

    expect(result.plan.byDate.has('2026-08-31')).toBe(false);
    expect([...result.plan.byDate.keys()].sort()).toEqual([
      '2026-09-01',
      '2026-10-29',
    ]);
  });
});

describe('moveRows guards (real SQL)', () => {
  const sql = () =>
    neonOverPglite(pg) as unknown as Parameters<typeof moveRows>[0];

  async function oneDoubledRow(): Promise<
    Parameters<typeof moveRows>[2][number]
  > {
    await seedLotteryFire(pg, {
      id: 1,
      date: '2026-10-29',
      at: '2026-10-29T14:45:00Z',
      ncp: 350,
      npp: 35,
      score: 50,
      scoreVersion: SEED,
    });
    return {
      table: 'lottery',
      id: '1',
      old: { ncp: '350', npp: '35', score: 50, version: SEED },
      new: { ncp: '175', npp: '17.5', score: 51, version: REFIT },
    };
  }

  it('skips a row whose score another writer changed after the plan was read', async () => {
    const change = await oneDoubledRow();
    await promote(REFIT, REFIT_WEIGHTS);
    await pg.query(`UPDATE lottery_finder_fires SET score = 77 WHERE id = 1`);

    expect(await moveRows(sql(), 'lottery', [change], 'apply')).toBe(0);

    expect(await lotteryRow(1)).toMatchObject({ ncp: '350', score: 77 });
  });

  it('skips a row whose flow another writer changed after the plan was read', async () => {
    const change = await oneDoubledRow();
    await promote(REFIT, REFIT_WEIGHTS);
    await pg.query(
      `UPDATE lottery_finder_fires SET cum_ncp_at_fire = 351 WHERE id = 1`,
    );

    expect(await moveRows(sql(), 'lottery', [change], 'apply')).toBe(0);
  });

  it('writes a new score tag only while the active pointer still names it', async () => {
    const change = await oneDoubledRow();
    // The pointer names the seed, not REFIT: the new tag would be a version the
    // store does not call active.
    expect(await moveRows(sql(), 'lottery', [change], 'apply')).toBe(0);
    expect(await lotteryRow(1)).toMatchObject({ ncp: '350', version: SEED });

    await promote(REFIT, REFIT_WEIGHTS);
    expect(await moveRows(sql(), 'lottery', [change], 'apply')).toBe(1);
    expect(await lotteryRow(1)).toEqual({
      ncp: '175',
      npp: '17.5',
      score: 51,
      version: REFIT,
    });
  });

  it('a row whose tag does not change is written whatever the pointer names', async () => {
    await oneDoubledRow();
    const change = {
      table: 'lottery' as const,
      id: '1',
      old: { ncp: '350', npp: '35', score: 50, version: SEED },
      new: { ncp: '175', npp: '17.5', score: 50, version: SEED },
    };
    await pg.exec(`DELETE FROM lottery_score_pointers`);

    expect(await moveRows(sql(), 'lottery', [change], 'apply')).toBe(1);
  });

  it('writes a silent boom row’s two flow columns, which has no score to guard', async () => {
    await seedSilentBoom(pg, {
      id: 10,
      date: '2026-10-29',
      at: '2026-10-29T14:45:00Z',
      ncp: 350,
      npp: 35,
    });

    const written = await moveRows(
      sql(),
      'silentboom',
      [
        {
          table: 'silentboom',
          id: '10',
          old: { ncp: '350', npp: '35', score: null, version: null },
          new: { ncp: '175', npp: '17.5', score: null, version: null },
        },
      ],
      'apply',
    );

    expect(written).toBe(1);
    expect(await silentRow(10)).toEqual({ ncp: '175', npp: '17.5' });
  });
});
