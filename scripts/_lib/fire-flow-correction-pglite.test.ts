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
 * written by a post-close reader holds twice the WS-only value. LATE has WS
 * ticks that start 770 ms into its first minute: a fire before them stored the
 * whole first history minute (look-ahead) and must go to NULL. Around them sit
 * the rows the script must leave alone: a value a live run wrote, a value that
 * matches nothing, a history-only day, a fire before the first tick that holds
 * something else, a fire before --since and a row with no flow.
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

const { pgRef, failRef, queryLog } = vi.hoisted(() => ({
  pgRef: { current: null as PGlite | null },
  failRef: {
    /** Every UPDATE rejects like a lost connection. */
    updates: false,
    /** Every read of the WS flow table rejects. */
    wsSelect: false,
    /** Only the WS gap read (the statement that names `gap_ncp`) rejects. */
    gapSelect: false,
    /** The per-fire reading of this ticker comes back empty. */
    shortLegacyFor: null as string | null,
    /** Runs once, just before the next UPDATE is sent. */
    beforeUpdate: null as (() => Promise<void>) | null,
  },
  /** The text and parameters of every statement the run sent, in order. */
  queryLog: [] as Array<{ text: string; params: unknown[] }>,
}));

// getDb() is a Neon-shaped client over pglite; everything else in db.js stays
// real. The `failRef` switches make one kind of statement misbehave.
vi.mock('../../api/_lib/db.js', async (importOriginal) => {
  const { neonOverPglite } =
    await import('../../api/__tests__/pglite-migrations');
  return {
    ...(await importOriginal<typeof import('../../api/_lib/db.js')>()),
    getDb: () => {
      const pg = pgRef.current;
      if (!pg) throw new Error('pglite not started');
      const real = neonOverPglite(pg);
      const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('');
        if (text.includes('UPDATE')) {
          if (failRef.updates)
            return Promise.reject(new Error('connection lost'));
          const hook = failRef.beforeUpdate;
          if (hook) {
            failRef.beforeUpdate = null;
            return hook().then(() => real(strings, ...values));
          }
        }
        if (failRef.wsSelect && text.includes('ws_net_flow_per_ticker')) {
          return Promise.reject(new Error('ws read failed: connection reset'));
        }
        if (failRef.gapSelect && text.includes('gap_ncp')) {
          return Promise.reject(new Error('gap read failed: connection reset'));
        }
        if (
          failRef.shortLegacyFor != null &&
          text.includes('WITH ORDINALITY') &&
          values.includes(failRef.shortLegacyFor)
        ) {
          return Promise.resolve([]);
        }
        const query = real(strings, ...values);
        queryLog.push({ text: query.text, params: query.params });
        return query;
      };
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
} from '../../api/__tests__/fire-flow-test-helpers';
import {
  formatReport,
  moveRows,
  readWsGaps,
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
  failRef.wsSelect = false;
  failRef.gapSelect = false;
  failRef.shortLegacyFor = null;
  failRef.beforeUpdate = null;
  queryLog.length = 0;
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
function run(apply: boolean, listLimit = 200): Promise<CorrectionResult> {
  fakeNow += 61_000;
  vi.setSystemTime(fakeNow);
  return runCorrection({ apply, since: SINCE, undoDir, listLimit });
}

/** Every row of both fire tables, whole, keyed `lottery:<id>` / `silentboom:<id>`. */
async function snapshot(): Promise<Record<string, Record<string, unknown>>> {
  const lottery = await pg.query<{ id: string; row: Record<string, unknown> }>(
    `SELECT id::text AS id, to_jsonb(f) AS row FROM lottery_finder_fires f`,
  );
  const silent = await pg.query<{ id: string; row: Record<string, unknown> }>(
    `SELECT id::text AS id, to_jsonb(s) AS row FROM silent_boom_alerts s`,
  );
  return Object.fromEntries([
    ...lottery.rows.map((r) => [`lottery:${r.id}`, r.row] as const),
    ...silent.rows.map((r) => [`silentboom:${r.id}`, r.row] as const),
  ]);
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
 *   2  AAA put, doubled 200/290 (aligned), score 40      -> against the flow: score NULL, active tag
 *   3  SNDK call, doubled 100/290 (unaligned), no score  -> with the flow: refit score, refit tag
 *   4  META call, live-written 175/17.5                  -> correct, untouched
 *   5  META call, 999/1                                  -> other (matches nothing), untouched
 *   6  IWM call, 150/15 on a history-only day            -> other (look-ahead only), untouched
 *   7  META call before the first tick, 350/35           -> other (no fixed value), untouched
 *   8  CCC call, doubled 100/290, 2026-09-01 (pre-seed)  -> flow corrected, score left
 *   9  DDD call, doubled, 2026-08-31 (before --since)    -> untouched
 *  12  META call, flow NULL                              -> not selected, counted
 *  13  LATE call before its first tick, 500/100 (the first history minute), score 55 (seed)
 *                                                         -> look-ahead: flow NULL, score NULL, active tag
 *  14  LATE call before its first tick, 7/7              -> other (no fixed value), untouched
 *  15  PRE call before its first tick, 500/100, 2026-09-01 (pre-seed), score 33, no tag
 *                                                         -> look-ahead: flow NULL, score NULL, tag left
 * Silent boom: 10 META doubled 350/35 -> corrected; 11 META 175/17.5 -> untouched;
 * 16 LATE at the bucket start, 500/100 -> look-ahead: flow NULL.
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
  // LATE (2026-10-29) and PRE (2026-09-01): the first WS tick lands 770 ms into
  // the first minute, so a fire in the opening second has no WS-only value, and
  // the first history minute (500/100) is the whole minute, ticks included.
  for (const [ticker, day] of [
    ['LATE', '2026-10-29'],
    ['PRE', '2026-09-01'],
  ] as const) {
    await insertWsTick(pg, ticker, `${day}T14:30:00.770Z`, 300, 60);
    await insertWsTick(pg, ticker, `${day}T14:30:30.000Z`, 200, 40);
    await insertHistoryMinute(pg, ticker, `${day}T14:30:00Z`, 500, 100);
  }

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
  await seedLotteryFire(pg, {
    id: 13,
    date: d,
    at: '2026-10-29T14:30:00.500Z',
    ticker: 'LATE',
    ncp: 500,
    npp: 100,
    score: 55,
    scoreVersion: SEED,
  });
  await seedLotteryFire(pg, {
    id: 14,
    date: d,
    at: '2026-10-29T14:30:00.600Z',
    ticker: 'LATE',
    ncp: 7,
    npp: 7,
  });
  await seedLotteryFire(pg, {
    id: 15,
    date: '2026-09-01',
    at: '2026-09-01T14:30:00.500Z',
    ticker: 'PRE',
    ncp: 500,
    npp: 100,
    score: 33,
  });
  await seedSilentBoom(pg, { id: 10, date: d, at, ncp: 350, npp: 35 });
  await seedSilentBoom(pg, { id: 11, date: d, at, ncp: 175, npp: 17.5 });
  await seedSilentBoom(pg, {
    id: 16,
    date: d,
    at: '2026-10-29T14:30:00.000Z',
    ticker: 'LATE',
    ncp: 500,
    npp: 100,
  });
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
    expect(result.plan.scanned).toEqual({ lottery: 11, silentboom: 3 });
    expect(result.plan.counts.lottery).toEqual({
      correct: 1,
      doubled: 4,
      lookahead: 2,
      other: 4,
    });
    expect(result.plan.counts.silentboom).toEqual({
      correct: 1,
      doubled: 1,
      lookahead: 1,
      other: 0,
    });
    expect(result.plan.toWrite).toEqual({ lottery: 6, silentboom: 2 });
    expect(result.nullFlow).toEqual({ lottery: 1, silentboom: 0 });
    expect(result.written).toEqual({ lottery: 0, silentboom: 0 });
    // The score outcome of each planned lottery row.
    expect(Object.fromEntries(result.plan.score)).toEqual({
      unchanged: 1,
      nulled: 2,
      'nulled-pre-seed': 1,
      set: 1,
      'left-pre-seed': 1,
    });
    expect([...result.plan.toUnaligned].sort()).toEqual(['13', '15', '2']);
    expect([...result.plan.toAligned].sort()).toEqual(['3', '8']);
    // The other rows are listed with why. A look-ahead row is not among them.
    expect(result.plan.otherRows.map((r) => [r.id, r.reason]).sort()).toEqual([
      ['14', 'no-fixed-value'],
      ['5', 'unmatched'],
      ['6', 'history-only-day'],
      ['7', 'no-fixed-value'],
    ]);
    // Every planned write is listed, by date, table and id.
    expect(
      result.plan.listedChanges.map(
        (c) => `${c.date} ${c.table} ${c.id} ${c.category}`,
      ),
    ).toEqual([
      '2026-09-01 lottery 8 doubled',
      '2026-09-01 lottery 15 lookahead',
      '2026-10-29 lottery 1 doubled',
      '2026-10-29 lottery 2 doubled',
      '2026-10-29 lottery 3 doubled',
      '2026-10-29 lottery 13 lookahead',
      '2026-10-29 silentboom 10 doubled',
      '2026-10-29 silentboom 16 lookahead',
    ]);
    // No history minute in this world lacks a WS tick: nothing to flag.
    expect(result.plan.gaps).toMatchObject({
      doubled: { lottery: 4, silentboom: 1 },
      withGap: { lottery: 0, silentboom: 0 },
      material: { lottery: 0, silentboom: 0 },
      flips: 0,
      rows: [],
    });
    // The three look-ahead fires (LATE, PRE, LATE's bucket) are all in their
    // ticker's first minute: no complete history minute before any of them.
    expect(result.plan.gaps.lookahead).toEqual({
      read: { lottery: 2, silentboom: 1 },
      withMinutes: { lottery: 0, silentboom: 0 },
      rows: [],
    });
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

    expect(result.written).toEqual({ lottery: 6, silentboom: 2 });
    // 1: the flow is WS-only; the alignment held, so the score and tag stay.
    expect(await lotteryRow(1)).toEqual({
      ncp: '175',
      npp: '17.5',
      score: 50,
      version: SEED,
    });
    // 2: now against the flow: NULL, and tagged with the active version, as
    // live scoring stores a NULL score (the tag was the seed's, the active
    // version is the refit).
    expect(await lotteryRow(2)).toEqual({
      ncp: '100',
      npp: '90',
      score: null,
      version: REFIT,
    });
    // 3: now with the flow: the ACTIVE (refit) weights score it and tag it.
    expect(await lotteryRow(3)).toEqual({
      ncp: '100',
      npp: '90',
      score: REFIT_SCORE_SNDK,
      version: REFIT,
    });
    // 8: before the seed weights were live, now with the flow: flow corrected,
    // score left.
    expect(await lotteryRow(8)).toEqual({
      ncp: '100',
      npp: '90',
      score: null,
      version: null,
    });
    // 13: look-ahead, was aligned: no flow, NULL score, the active tag.
    expect(await lotteryRow(13)).toEqual({
      ncp: null,
      npp: null,
      score: null,
      version: REFIT,
    });
    // 15: look-ahead before the seed weights were live: no flow, NULL score,
    // the tag it had (none) left.
    expect(await lotteryRow(15)).toEqual({
      ncp: null,
      npp: null,
      score: null,
      version: null,
    });
    expect(await silentRow(10)).toEqual({ ncp: '175', npp: '17.5' });
    expect(await silentRow(16)).toEqual({ ncp: null, npp: null });
    // Everything else is byte for byte what it was: the live-written row, the
    // unmatched row, the history-only row, the pre-tick rows that match no
    // history minute, the row before --since, the row with no flow, the
    // untouched silent boom row.
    const after = await snapshot();
    const UNTOUCHED = [
      'lottery:4',
      'lottery:5',
      'lottery:6',
      'lottery:7',
      'lottery:9',
      'lottery:12',
      'lottery:14',
      'silentboom:11',
    ];
    const MOVED = [
      'lottery:1',
      'lottery:2',
      'lottery:3',
      'lottery:8',
      'lottery:13',
      'lottery:15',
      'silentboom:10',
      'silentboom:16',
    ];
    for (const key of UNTOUCHED) {
      expect(after[key], key).toEqual(before[key]);
    }
    // And on the rows that moved, only the written columns differ.
    for (const key of MOVED) {
      expect(withoutWritten(after[key]!), key).toEqual(
        withoutWritten(before[key]!),
      );
    }
    expect(result.undoFile).not.toBeNull();
  });

  it('a look-ahead row round-trips: apply writes NULL flow, undo restores the first history minute exactly, a second apply writes nothing', async () => {
    await promote(REFIT, REFIT_WEIGHTS);
    await seedWorld();
    const before = await snapshot();
    const lotteryBefore = await lotteryRow(13);
    const silentBefore = await silentRow(16);
    expect(lotteryBefore).toMatchObject({ score: 55, version: SEED });
    expect(Number(lotteryBefore.ncp)).toBe(500);

    const applied = await run(true);
    const settled = await snapshot();
    expect(await lotteryRow(13)).toMatchObject({ ncp: null, npp: null });
    expect(await silentRow(16)).toEqual({ ncp: null, npp: null });

    // A second apply: the NULL rows are not selected (the backfill's job, and
    // it would give NULL again), so nothing is planned and nothing written.
    const again = await run(true);
    expect(again.plan.toWrite).toEqual({ lottery: 0, silentboom: 0 });
    expect(again.plan.counts.lottery.lookahead).toBe(0);
    expect(again.written).toEqual({ lottery: 0, silentboom: 0 });
    expect(again.undoFile).toBeNull();
    expect(again.nullFlow).toEqual({ lottery: 3, silentboom: 1 });
    expect(await snapshot()).toEqual(settled);

    // The undo moves the rows back from NULL: both flow columns, score and tag.
    const undone = await runUndo({ file: applied.undoFile!, apply: true });
    expect(undone.restored).toEqual({ lottery: 6, silentboom: 2 });
    expect(await lotteryRow(13)).toEqual(lotteryBefore);
    expect(await silentRow(16)).toEqual(silentBefore);
    expect(await snapshot()).toEqual(before);
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
      'lottery:13',
      'lottery:15',
      'lottery:2',
      'lottery:3',
      'lottery:8',
      'silentboom:10',
      'silentboom:16',
    ]);
    // The active version here is the seed, so the NULLed score keeps the tag it
    // had; the flow of a look-ahead row goes to null.
    expect(byId.get('lottery:2')).toMatchObject({
      old: { ncp: '200', npp: '290', score: 40, version: SEED },
      new: { ncp: '100', npp: '90', score: null, version: SEED },
    });
    expect(byId.get('lottery:13')).toMatchObject({
      old: { score: 55, version: SEED },
      new: { ncp: null, npp: null, score: null, version: SEED },
    });
    expect(Number(byId.get('lottery:13')?.old.ncp)).toBe(500);
  });

  it('a second apply finds nothing doubled, and writes nothing and no second undo file', async () => {
    await seedWorld();
    await run(true);
    const settled = await snapshot();

    const again = await run(true);

    expect(await snapshot()).toEqual(settled);
    expect(again.plan.toWrite).toEqual({ lottery: 0, silentboom: 0 });
    expect(again.plan.counts.lottery.doubled).toBe(0);
    expect(again.plan.counts.lottery.lookahead).toBe(0);
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
    expect(dry.rows).toEqual({ lottery: 6, silentboom: 2 });
    expect(dry.restored).toEqual({ lottery: 0, silentboom: 0 });

    const undone = await runUndo({ file: applied.undoFile!, apply: true });

    expect(undone.restored).toEqual({ lottery: 6, silentboom: 2 });
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

    // Row 1 and silent boom row 10 were changed by someone else: skipped. The
    // other five lottery rows and silent boom row 16 are restored.
    expect(undone.restored).toEqual({ lottery: 5, silentboom: 1 });
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
    expect(rerun.written).toEqual({ lottery: 6, silentboom: 2 });
    // The pointer never moved: no note in the report.
    expect(rerun.pointerMoved).toBeNull();
    expect(formatReport(rerun)).not.toContain('active pointer moved');
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

  it('a dry run lists every planned write with its old and new values, and --list-limit cuts the list but not the counts', async () => {
    await promote(REFIT, REFIT_WEIGHTS);
    await seedWorld();

    const full = formatReport(await run(false));
    const capped = await run(false, 3);
    const cappedReport = formatReport(capped);

    expect(full).toContain('Planned writes, fire time in UTC (8 of 8 listed):');
    expect(full).toContain(
      `  lottery 2 2026-10-29 AAA 14:45:00.000Z doubled: flow 200 / 290 -> 100 / 90; score 40 (${SEED}) -> NULL (${REFIT})`,
    );
    expect(full).toContain(
      `  lottery 13 2026-10-29 LATE 14:30:00.500Z look-ahead: flow 500 / 100 -> NULL / NULL; score 55 (${SEED}) -> NULL (${REFIT})`,
    );
    expect(full).toContain(
      '  silentboom 16 2026-10-29 LATE 14:30:00.000Z look-ahead: flow 500 / 100 -> NULL / NULL\n',
    );
    // The cap: 3 listed, the other 5 counted, every total still exact.
    expect(capped.plan.listedChanges.map((c) => c.id)).toEqual([
      '8',
      '15',
      '1',
    ]);
    expect(cappedReport).toContain(
      'Planned writes, fire time in UTC (3 of 8 listed):',
    );
    expect(cappedReport).toContain('... 5 more not listed (--list-limit)');
    expect(capped.plan.toWrite).toEqual({ lottery: 6, silentboom: 2 });
    expect(cappedReport).toContain('To write: lottery 6, silent boom 2');
  });

  describe('failure modes of the plan and the writes', () => {
    it('names both versions, the rows written out of the rows planned and the undo file when the active pointer moves between the plan and the writes', async () => {
      await seedWorld();
      // A fire that is now against the flow and carries an older tag: moving
      // it onto the active version needs the pointer, so it is not written
      // once the pointer has moved.
      await seedLotteryFire(pg, {
        id: 17,
        date: '2026-10-29',
        at: '2026-10-29T14:45:00Z',
        ticker: 'AAA',
        optionType: 'P',
        ncp: 200,
        npp: 290,
        score: 41,
        scoreVersion: 'older-2026-10-01',
      });
      // The pointer moves just before the first UPDATE: after the plan, which
      // scored with the seed.
      failRef.beforeUpdate = () => promote(REFIT, REFIT_WEIGHTS);

      const failure = await run(true).then(
        () => null,
        (err: unknown) => err as Error,
      );

      const files = readdirSync(undoDir);
      expect(files).toHaveLength(1);
      expect(failure?.message).toContain(
        `the active pointer moved from ${SEED} to ${REFIT} during the run`,
      );
      expect(failure?.message).toContain(join(undoDir, files[0]!));
      // 7 lottery rows and 2 silent boom rows planned; 5 and 2 written.
      expect(failure?.message).toContain(
        `7 of 9 planned rows were written under ${SEED} before it moved (lottery 5 of 7, silent boom 2 of 2)`,
      );
      // Written: the flow-only row, the NULLed row that already carried the
      // seed tag (the tag does not change), both look-ahead rows, the pre-seed
      // row and both silent boom rows.
      expect((await lotteryRow(1)).ncp).toBe('175');
      expect(await lotteryRow(2)).toMatchObject({ score: null, version: SEED });
      expect(await lotteryRow(13)).toMatchObject({
        ncp: null,
        score: null,
        version: SEED,
      });
      expect((await lotteryRow(15)).ncp).toBeNull();
      expect((await lotteryRow(8)).npp).toBe('90');
      expect((await silentRow(10)).ncp).toBe('175');
      expect((await silentRow(16)).ncp).toBeNull();
      // Not written: the `set` row (null tag to the seed) and the NULLed row
      // whose tag would change, both needing the pointer on the seed.
      expect(await lotteryRow(3)).toMatchObject({
        npp: '290',
        score: null,
        version: null,
      });
      expect(await lotteryRow(17)).toMatchObject({
        ncp: '200',
        score: 41,
        version: 'older-2026-10-01',
      });
    });

    it('when the active pointer moves but every planned row was still written, the run completes: a note, no rejection, no claim that rows were left', async () => {
      // META alone: a doubled lottery row whose alignment holds (flow only,
      // the tag stays) and a doubled silent boom row. Neither needs the
      // pointer, so a move before the first UPDATE leaves nothing unwritten.
      await insertWsTick(pg, 'META', '2026-10-29T14:30:00.984Z', 100, 10);
      await insertWsTick(pg, 'META', '2026-10-29T14:30:31.250Z', 50, 5);
      await insertWsTick(pg, 'META', '2026-10-29T14:31:02.007Z', 25, 2.5);
      await insertHistoryMinute(pg, 'META', '2026-10-29T14:30:00Z', 150, 15);
      await insertHistoryMinute(pg, 'META', '2026-10-29T14:31:00Z', 25, 2.5);
      const at = '2026-10-29T14:45:00Z';
      await seedLotteryFire(pg, {
        id: 1,
        date: '2026-10-29',
        at,
        ncp: 350,
        npp: 35,
        score: 50,
        scoreVersion: SEED,
      });
      await seedSilentBoom(pg, {
        id: 10,
        date: '2026-10-29',
        at,
        ncp: 350,
        npp: 35,
      });
      failRef.beforeUpdate = () => promote(REFIT, REFIT_WEIGHTS);

      const result = await run(true);

      expect(result.written).toEqual({ lottery: 1, silentboom: 1 });
      expect(result.pointerMoved).toEqual({ to: REFIT });
      expect(await lotteryRow(1)).toEqual({
        ncp: '175',
        npp: '17.5',
        score: 50,
        version: SEED,
      });
      expect((await silentRow(10)).ncp).toBe('175');
      const report = formatReport(result);
      expect(report).toContain(
        `NOTE: the active pointer moved from ${SEED} to ${REFIT} during the run, after the plan was read. All 2 planned rows were written anyway`,
      );
      expect(report).not.toContain('not written');
      expect(report).not.toContain('WARNING');
      expect(readdirSync(undoDir)).toHaveLength(1);
    });

    it('a failed read of the WS table while planning rejects the run before any file or write', async () => {
      await seedWorld();
      const before = await snapshot();
      failRef.wsSelect = true;

      await expect(run(true)).rejects.toThrow(
        'ws read failed: connection reset',
      );

      expect(readdirSync(undoDir)).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });

    it('a per-fire reading with the wrong row count rejects the run and names the ticker and the date', async () => {
      await seedWorld();
      const before = await snapshot();
      failRef.shortLegacyFor = 'META';

      await expect(run(true)).rejects.toThrow(
        'META 2026-10-29: asked for 6 fire readings, got 0',
      );

      expect(readdirSync(undoDir)).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });
  });
});

/**
 * The WS gap fixture, 2026-10-29. Every history minute holds the flow of the WS
 * ticks inside it, except where noted.
 *   GAP    WS ticks at 14:30:10.5 (600/10) and 14:41:05.25 (400/40), so the
 *          WS-only flow is 1,000 / 50. History has the same two minutes, and
 *          five more, 14:35 to 14:39, of 0 / 300 each: a five-minute WS hole
 *          with 1,500 of put premium in it. A call fire at 14:45 would stop being
 *          aligned (1,000 against 1,550) if the hole were filled.
 *            lottery 20  call at 14:45:00, doubled 2000 / 1600     -> material gap, flips
 *            silent  21  at 14:37:30, doubled 1200 / 920           -> 2 minutes complete, material
 *   MINOR  one WS tick of 100,000 / 10 and a history minute of 100 / 0 at 14:33
 *          that has no tick: a gap, but 0.1% of the corrected call flow.
 *            lottery 22  call at 14:45:00, doubled 200100 / 20     -> gap, not material
 *   CLEAN  a ticker-day with a live-written row and nothing to correct.
 *            lottery 23  call at 14:45:00, 50 / 5                  -> correct; no gap read
 */
async function seedGapWorld(): Promise<void> {
  const day = '2026-10-29';
  await insertWsTick(pg, 'GAP', `${day}T14:30:10.500Z`, 600, 10);
  await insertWsTick(pg, 'GAP', `${day}T14:41:05.250Z`, 400, 40);
  await insertHistoryMinute(pg, 'GAP', `${day}T14:30:00Z`, 600, 10);
  for (const minute of ['35', '36', '37', '38', '39']) {
    await insertHistoryMinute(pg, 'GAP', `${day}T14:${minute}:00Z`, 0, 300);
  }
  await insertHistoryMinute(pg, 'GAP', `${day}T14:41:00Z`, 400, 40);
  await insertWsTick(pg, 'MINOR', `${day}T14:30:10.500Z`, 100_000, 10);
  await insertHistoryMinute(pg, 'MINOR', `${day}T14:30:00Z`, 100_000, 10);
  await insertHistoryMinute(pg, 'MINOR', `${day}T14:33:00Z`, 100, 0);
  await insertWsTick(pg, 'CLEAN', `${day}T14:30:10.500Z`, 50, 5);
  await insertHistoryMinute(pg, 'CLEAN', `${day}T14:30:00Z`, 50, 5);

  const at = `${day}T14:45:00Z`;
  await seedLotteryFire(pg, {
    id: 20,
    date: day,
    at,
    ticker: 'GAP',
    ncp: 2000,
    npp: 1600,
    score: 50,
    scoreVersion: SEED,
  });
  await seedSilentBoom(pg, {
    id: 21,
    date: day,
    at: `${day}T14:37:30Z`,
    ticker: 'GAP',
    ncp: 1200,
    npp: 920,
  });
  await seedLotteryFire(pg, {
    id: 22,
    date: day,
    at,
    ticker: 'MINOR',
    ncp: 200_100,
    npp: 20,
  });
  await seedLotteryFire(pg, {
    id: 23,
    date: day,
    at,
    ticker: 'CLEAN',
    ncp: 50,
    npp: 5,
  });
}

/**
 * The look-ahead fixtures, 2026-10-29 (CDT: the session opens 13:30:00Z).
 *   LK    its first WS tick is at 13:45:20.5, so every fire before it is
 *         look-ahead. History: 13:30 400 / 40, 13:31 to 13:39 100 / 10 each,
 *         13:40 50 / 5.
 *           lottery 30  call at 13:40:30, 10 minutes after the open: holds the
 *                       history sum with ts <= fire, 1,350 / 135 -> look-ahead,
 *                       with ten complete minutes (1,300 / 130) before it
 *           silent  32  at 13:35:00, 900 / 90                    -> look-ahead,
 *                       five complete minutes (800 / 80) before it
 *   OPEN  its first WS tick is at 13:30:00.77, inside the first history minute
 *         (13:30, 500 / 100).
 *           lottery 31  call at 13:30:00.5, 500 / 100            -> look-ahead,
 *                       and no minute is complete before it
 */
async function seedMidSessionLookahead(): Promise<void> {
  const day = '2026-10-29';
  await insertWsTick(pg, 'LK', `${day}T13:45:20.500Z`, 100, 10);
  await insertHistoryMinute(pg, 'LK', `${day}T13:30:00Z`, 400, 40);
  for (let minute = 31; minute <= 39; minute += 1) {
    await insertHistoryMinute(pg, 'LK', `${day}T13:${minute}:00Z`, 100, 10);
  }
  await insertHistoryMinute(pg, 'LK', `${day}T13:40:00Z`, 50, 5);
  await seedLotteryFire(pg, {
    id: 30,
    date: day,
    at: `${day}T13:40:30Z`,
    ticker: 'LK',
    ncp: 1350,
    npp: 135,
  });
  await seedSilentBoom(pg, {
    id: 32,
    date: day,
    at: `${day}T13:35:00Z`,
    ticker: 'LK',
    ncp: 900,
    npp: 90,
  });
}

async function seedOpeningSecondLookahead(): Promise<void> {
  const day = '2026-10-29';
  await insertWsTick(pg, 'OPEN', `${day}T13:30:00.770Z`, 300, 60);
  await insertHistoryMinute(pg, 'OPEN', `${day}T13:30:00Z`, 500, 100);
  await seedLotteryFire(pg, {
    id: 31,
    date: day,
    at: `${day}T13:30:00.500Z`,
    ticker: 'OPEN',
    ncp: 500,
    npp: 100,
  });
}

describe('WS gaps of the doubled rows (real SQL)', () => {
  const gapQueries = () => queryLog.filter((q) => q.text.includes('gap_ncp'));

  it('finds a five-minute WS hole in a doubled row, says it is material and that it would flip the alignment', async () => {
    await seedGapWorld();

    const result = await run(false);

    // The corrected value is WS-only, hole and all: 1,000 / 50, not 1,000 / 1,550.
    const gapRow = result.plan.listedChanges.find((c) => c.id === '20');
    expect(gapRow).toMatchObject({
      category: 'doubled',
      new: { ncp: '1000', npp: '50' },
      gap: { minutes: 5, ncp: 0, npp: 1500, material: true, flips: true },
    });
    // The silent boom fire at 14:37:30 had only two of the five minutes
    // complete, and has no alignment to flip.
    expect(
      result.plan.listedChanges.find((c) => c.table === 'silentboom')?.gap,
    ).toEqual({ minutes: 2, ncp: 0, npp: 600, material: true, flips: null });
    // A gap that is 0.1% of the call flow is counted, not material.
    expect(
      result.plan.listedChanges.find((c) => c.id === '22')?.gap,
    ).toMatchObject({ minutes: 1, ncp: 100, npp: 0, material: false });
    expect(result.plan.gaps).toEqual({
      doubled: { lottery: 2, silentboom: 1 },
      withGap: { lottery: 2, silentboom: 1 },
      material: { lottery: 1, silentboom: 1 },
      flips: 1,
      lookahead: {
        read: { lottery: 0, silentboom: 0 },
        withMinutes: { lottery: 0, silentboom: 0 },
        rows: [],
      },
      rows: [
        {
          table: 'lottery',
          id: '20',
          date: '2026-10-29',
          ticker: 'GAP',
          minutes: 5,
          gapNcp: 0,
          gapNpp: 1500,
          ncp: 1000,
          npp: 50,
          flips: true,
        },
        {
          table: 'silentboom',
          id: '21',
          date: '2026-10-29',
          ticker: 'GAP',
          minutes: 2,
          gapNcp: 0,
          gapNpp: 600,
          ncp: 600,
          npp: 10,
          flips: null,
        },
      ],
    });
    // The report words it, flags the open decision, and writes nothing from it.
    const report = formatReport(result);
    expect(report).toContain('open owner decision');
    expect(report).toContain(
      '  lottery 20 2026-10-29 GAP: 5 gap minutes, gap flow 0 / 1,500, corrected 1,000 / 50, flips yes',
    );
    expect(report).toContain(
      '  silentboom 21 2026-10-29 GAP: 2 gap minutes, gap flow 0 / 600, corrected 600 / 10, flips n/a',
    );
  });

  it('reads the gap once per ticker-day that has a doubled row, never per fire, and not for a ticker-day with nothing doubled', async () => {
    await seedGapWorld();

    await run(false);

    // GAP has two doubled rows (a lottery fire and a silent boom fire) and
    // MINOR has one: two ticker-days, two reads. CLEAN's only row is correct.
    const queries = gapQueries();
    expect(queries).toHaveLength(2);
    expect(queries.map((q) => q.params[0]).sort()).toEqual(['GAP', 'MINOR']);
  });

  it('reads no gap at all when nothing is doubled', async () => {
    await seedLotteryFire(pg, {
      id: 23,
      date: '2026-10-29',
      at: '2026-10-29T14:45:00Z',
      ticker: 'CLEAN',
      ncp: 50,
      npp: 5,
    });
    await insertWsTick(pg, 'CLEAN', '2026-10-29T14:30:10.500Z', 50, 5);
    await insertHistoryMinute(pg, 'CLEAN', '2026-10-29T14:30:00Z', 50, 5);

    const result = await run(false);

    expect(gapQueries()).toHaveLength(0);
    expect(result.plan.gaps.doubled).toEqual({ lottery: 0, silentboom: 0 });
    expect(formatReport(result)).not.toContain('WS gaps');
  });

  it('a failed read of the WS gaps while planning rejects the run before any file or write', async () => {
    await seedGapWorld();
    const before = await snapshot();
    failRef.gapSelect = true;

    await expect(run(true)).rejects.toThrow(
      'gap read failed: connection reset',
    );

    expect(readdirSync(undoDir)).toEqual([]);
    expect(await snapshot()).toEqual(before);
    // Planning reached the gap read (the per-fire readings ran) and nothing
    // wrote.
    expect(queryLog.some((q) => q.text.includes('WITH ORDINALITY'))).toBe(true);
    expect(queryLog.some((q) => q.text.includes('UPDATE'))).toBe(false);
  });

  it('a WS tick after the session close does not hide the gap of the last history minute: the probe is bounded like the series', async () => {
    // 2026-10-29 closes the session at 15:00 CT = 20:00:00Z, inclusive. The
    // series reads no WS tick after it, so the minute starting at the close is
    // a gap even though a tick lands 30 s into it.
    await insertWsTick(pg, 'END', '2026-10-29T14:30:10.500Z', 1, 1);
    await insertWsTick(pg, 'END', '2026-10-29T20:00:30.000Z', 5, 5);
    await insertHistoryMinute(pg, 'END', '2026-10-29T20:00:00Z', 0, 300);

    const minutes = await readWsGaps(
      neonOverPglite(pg) as unknown as Parameters<typeof readWsGaps>[0],
      'END',
      '2026-10-29',
    );

    expect(minutes.map((m) => new Date(m.ts).toISOString())).toEqual([
      '2026-10-29T20:00:00.000Z',
    ]);
  });

  describe('look-ahead rows', () => {
    it('lists the fire ten minutes into the session, which holds ten complete history minutes, and not the fire in the opening second', async () => {
      await seedMidSessionLookahead();
      await seedOpeningSecondLookahead();

      const result = await run(false);

      expect(result.plan.counts.lottery.lookahead).toBe(2);
      expect(result.plan.counts.silentboom.lookahead).toBe(1);
      expect(result.plan.gaps.lookahead).toEqual({
        read: { lottery: 2, silentboom: 1 },
        withMinutes: { lottery: 1, silentboom: 1 },
        rows: [
          {
            table: 'lottery',
            id: '30',
            date: '2026-10-29',
            ticker: 'LK',
            fireAt: '2026-10-29T13:40:30.000Z',
            minutes: 10,
            gapNcp: 1300,
            gapNpp: 130,
          },
          {
            table: 'silentboom',
            id: '32',
            date: '2026-10-29',
            ticker: 'LK',
            fireAt: '2026-10-29T13:35:00.000Z',
            minutes: 5,
            gapNcp: 800,
            gapNpp: 80,
          },
        ],
      });
      const report = formatReport(result);
      expect(report).toContain(
        'holding at least one complete nonzero history minute before the fire: lottery 1, silent boom 1',
      );
      expect(report).toContain(
        '  lottery 30 2026-10-29 LK 13:40:30.000Z: 10 gap minutes, gap flow 1,300 / 130',
      );
      expect(report).toContain(
        '  silentboom 32 2026-10-29 LK 13:35:00.000Z: 5 gap minutes, gap flow 800 / 80',
      );
      // The opening-second fire is read and counted, and not listed.
      expect(report).toContain(
        'Look-ahead rows read: lottery 2, silent boom 1',
      );
      expect(report).not.toMatch(/lottery 31 [^\n]*gap minute/);
    });

    it('prints an explicit zero when every look-ahead fire is in the opening second', async () => {
      await seedOpeningSecondLookahead();

      const result = await run(false);

      expect(result.plan.counts.lottery.lookahead).toBe(1);
      expect(result.plan.gaps.lookahead).toEqual({
        read: { lottery: 1, silentboom: 0 },
        withMinutes: { lottery: 0, silentboom: 0 },
        rows: [],
      });
      const report = formatReport(result);
      expect(report).toContain(
        'Look-ahead rows read: lottery 1, silent boom 0',
      );
      expect(report).toContain(
        'holding at least one complete nonzero history minute before the fire: lottery 0, silent boom 0',
      );
      expect(report).not.toMatch(/gap minute/);
    });

    it('reads the gap once per ticker-day with a look-ahead row, also when the same day has a doubled row', async () => {
      await seedMidSessionLookahead();
      await seedOpeningSecondLookahead();
      // LK, after its first WS tick: the WS tick plus the whole history.
      await seedLotteryFire(pg, {
        id: 33,
        date: '2026-10-29',
        at: '2026-10-29T13:50:00Z',
        ticker: 'LK',
        ncp: 1450,
        npp: 145,
      });

      const result = await run(false);

      expect(result.plan.counts.lottery).toMatchObject({
        doubled: 1,
        lookahead: 2,
      });
      // LK: three rows (two look-ahead, one doubled), one read. OPEN: one row,
      // one read.
      const queries = gapQueries();
      expect(queries).toHaveLength(2);
      expect(queries.map((q) => q.params[0]).sort()).toEqual(['LK', 'OPEN']);
      // Both blocks come from the same read.
      expect(result.plan.listedChanges.find((c) => c.id === '33')?.gap).toEqual(
        { minutes: 11, ncp: 1350, npp: 135, material: true, flips: false },
      );
      expect(result.plan.gaps.lookahead.withMinutes).toEqual({
        lottery: 1,
        silentboom: 1,
      });
    });
  });

  it('reads the WS table only through its (ticker, ts) unique index, never a scan of the table', async () => {
    await seedGapWorld();
    // Migration #199 dropped the redundant (ticker, ts DESC) copy on production;
    // the fixture still has it (it is built from #121, and #210 already swapped
    // the plain unique index for the covering one), so drop it here and the
    // plan can only name the unique index the production probe uses.
    await pg.exec('DROP INDEX IF EXISTS ws_net_flow_per_ticker_ticker_ts_idx');
    const real = neonOverPglite(pg);
    const captured: Array<{ text: string; params: unknown[] }> = [];
    const spy = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = real(strings, ...values);
        captured.push({ text: query.text, params: query.params });
        return query;
      },
      { query: real.query, transaction: real.transaction },
    );

    const minutes = await readWsGaps(
      spy as unknown as Parameters<typeof readWsGaps>[0],
      'GAP',
      '2026-10-29',
    );

    // The five empty history minutes, not the two that hold WS ticks.
    expect(minutes.map((m) => new Date(m.ts).toISOString())).toEqual([
      '2026-10-29T14:35:00.000Z',
      '2026-10-29T14:36:00.000Z',
      '2026-10-29T14:37:00.000Z',
      '2026-10-29T14:38:00.000Z',
      '2026-10-29T14:39:00.000Z',
    ]);
    expect(minutes.every((m) => m.ncp === 0 && m.npp === 300)).toBe(true);
    // The plan, with sequential scans switched off so a table this small still
    // has to name an index if one can serve the probe.
    expect(captured).toHaveLength(1);
    const { text, params } = captured[0]!;
    await pg.exec('SET enable_seqscan = off');
    try {
      const plan = await pg.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${text}`,
        params,
      );
      const nodes: Array<Record<string, unknown>> = [];
      const walk = (node: unknown): void => {
        if (node == null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        nodes.push(node as Record<string, unknown>);
        Object.values(node).forEach(walk);
      };
      walk(plan.rows[0]?.['QUERY PLAN']);
      const wsScans = nodes.filter(
        (n) => n['Relation Name'] === 'ws_net_flow_per_ticker',
      );
      expect(wsScans.length).toBeGreaterThan(0);
      // Every read of the WS table goes through an index ...
      for (const scan of wsScans) {
        expect(String(scan['Node Type'])).toMatch(/Index|Bitmap/);
      }
      // ... and the one a scan names is the (ticker, ts) unique index, never
      // the (ts)-only one.
      const named = wsScans
        .map((n) => n['Index Name'])
        .filter((name): name is string => typeof name === 'string');
      for (const name of named) {
        expect(name).toBe('ws_net_flow_per_ticker_cov_uq');
      }
      const bitmapIndexes = nodes
        .filter((n) => n['Node Type'] === 'Bitmap Index Scan')
        .map((n) => String(n['Index Name']))
        .filter((name) => name.startsWith('ws_net_flow_per_ticker'));
      for (const name of bitmapIndexes) {
        expect(name).toBe('ws_net_flow_per_ticker_cov_uq');
      }
      expect(named.length + bitmapIndexes.length).toBeGreaterThan(0);
    } finally {
      await pg.exec('RESET enable_seqscan');
    }
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

  it('moves a flow from a number to NULL on apply and back on undo: NULL is a value the guard compares', async () => {
    await oneDoubledRow();
    const lookahead = {
      table: 'lottery' as const,
      id: '1',
      old: { ncp: '350', npp: '35', score: 50, version: SEED },
      new: { ncp: null, npp: null, score: null, version: SEED },
    };

    expect(await moveRows(sql(), 'lottery', [lookahead], 'apply')).toBe(1);
    expect(await lotteryRow(1)).toEqual({
      ncp: null,
      npp: null,
      score: null,
      version: SEED,
    });
    // Applying again: the row no longer holds the old numbers.
    expect(await moveRows(sql(), 'lottery', [lookahead], 'apply')).toBe(0);

    expect(await moveRows(sql(), 'lottery', [lookahead], 'undo')).toBe(1);
    expect(await lotteryRow(1)).toEqual({
      ncp: '350',
      npp: '35',
      score: 50,
      version: SEED,
    });
    // Undoing again: the row no longer holds the NULLs.
    expect(await moveRows(sql(), 'lottery', [lookahead], 'undo')).toBe(0);
  });

  it('a NULL-flow move for silent boom is guarded and reversible the same way', async () => {
    await seedSilentBoom(pg, {
      id: 10,
      date: '2026-10-29',
      at: '2026-10-29T14:30:00Z',
      ncp: 500,
      npp: 100,
    });
    const change = {
      table: 'silentboom' as const,
      id: '10',
      old: { ncp: '500', npp: '100', score: null, version: null },
      new: { ncp: null, npp: null, score: null, version: null },
    };

    expect(await moveRows(sql(), 'silentboom', [change], 'apply')).toBe(1);
    expect(await silentRow(10)).toEqual({ ncp: null, npp: null });
    expect(await moveRows(sql(), 'silentboom', [change], 'apply')).toBe(0);
    expect(await moveRows(sql(), 'silentboom', [change], 'undo')).toBe(1);
    expect(Number((await silentRow(10)).ncp)).toBe(500);
    expect(await moveRows(sql(), 'silentboom', [change], 'undo')).toBe(0);
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
