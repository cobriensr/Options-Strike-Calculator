// @vitest-environment node

/**
 * REAL-SQL test for the post-close flow repair (api/_lib/fire-flow-repair.ts):
 * the selection, the series read (the Phase A rule), the conditional batched
 * write, the lottery re-score and the residual accounting run against the fire
 * tables, the two net-flow tables and the weights store built from the REAL
 * migrations in pglite, and the rows are read back. The cron tests
 * (enrich-lottery-outcomes.test.ts, enrich-silent-boom-outcomes.test.ts) cover
 * how the two crons use its result.
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may depend
 * on the session time zone. 2026-11-16 is CST: the session is 14:30Z to 21:00Z.
 */

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

const { pgRef, mockCaptureMessage, mockCaptureException } = vi.hoisted(() => ({
  pgRef: { current: null as PGlite | null },
  mockCaptureMessage: vi.fn(),
  mockCaptureException: vi.fn(),
}));

// getDb() (the weights loader's handle) is a Neon-shaped client over pglite;
// everything else in db.js stays real, withDbRetry and isRetryableDbError too.
vi.mock('../_lib/db.js', async (importOriginal) => {
  const { neonOverPglite } = await import('./pglite-migrations');
  return {
    ...(await importOriginal<typeof import('../_lib/db.js')>()),
    getDb: () => {
      const pg = pgRef.current;
      if (!pg) throw new Error('pglite not started');
      return neonOverPglite(pg);
    },
  };
});
vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureMessage: mockCaptureMessage,
    captureException: mockCaptureException,
  },
  metrics: {},
}));
// The detectors' 15 s series deadline, shortened so the test that lets a read
// pass it takes a fraction of a second. Everything else in the module is real.
vi.mock('../_lib/ticker-flow-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/ticker-flow-snapshot.js')>()),
  FLOW_SERIES_DEADLINE_MS: 300,
}));

import {
  buildFireTables,
  clearFireData,
  insertHistoryMinute,
  insertWsTick,
  resetWeightsStore,
  seedLotteryFire,
  seedSilentBoom,
  type LotterySeed,
} from '../../scripts/_lib/fire-flow-test-helpers';
import {
  FLOW_REPAIR_CRON_MAX_DURATION_MS,
  FLOW_REPAIR_LOOKBACK_DAYS,
  FLOW_REPAIR_MARGIN_MS,
  lookbackDates,
  repairNullFlow,
  selectNullFlowGroups,
  type FlowRepairOutcome,
  type FlowRepairTable,
} from '../_lib/fire-flow-repair.js';
import {
  isAlignedFire,
  scoreLotteryV2,
  weekdayOf,
} from '../_lib/lottery-score-weights-v2.js';
import { loadLotteryWeights } from '../_lib/lottery-weights-loader.js';
import type { LotteryWeights } from '../_lib/lottery-weights-schema.js';
import {
  SEED_LOTTERY_WEIGHTS,
  SEED_LOTTERY_WEIGHTS_VERSION,
} from '../_lib/lottery-weights-seed.js';
import { neonOverPglite } from './pglite-migrations';

type Db = Parameters<typeof repairNullFlow>[0];
type Hook = (text: string, params: unknown[]) => Promise<void> | void;

const TODAY = '2026-11-16';
const SEED = SEED_LOTTERY_WEIGHTS_VERSION;
const REFIT = 'refit-2026-11-20';

// A later version's weights: the seed with two weights changed.
const REFIT_WEIGHTS: LotteryWeights = (() => {
  const copy = structuredClone(SEED_LOTTERY_WEIGHTS);
  copy.features.ticker_weights.META =
    (copy.features.ticker_weights.META ?? 0) + 3;
  copy.features.option_type_weights.P += 2;
  return copy;
})();

let pg: PGlite;
// The weights loader keeps what it read for 60 s of Date.now(). Each run below
// is a fresh cron process, so before it the clock is moved a minute past the
// last load (only Date is faked: pglite's own timers stay real) and the loader
// is asked once, which caches the store as the test left it, dated after the
// run's own start: the run then reads that. Without it a test would score with
// the weights an earlier test cached.
let loaderClock = Date.parse('2027-01-04T00:00:00Z');
let runs = 0;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
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
  runs = 0;
  vi.clearAllMocks();
  await clearFireData(pg);
  await resetWeightsStore(pg);
});

afterEach(async () => {
  await pg.query('RESET enable_seqscan');
});

/** The tagged-template client over pglite, with `hook` run before each statement. */
function intercept(hook: Hook): Db {
  const base = neonOverPglite(pg);
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = base(strings, ...values);
    return {
      text: q.text,
      params: q.params,
      then: (
        onFulfilled: (rows: unknown[]) => unknown,
        onRejected: (err: unknown) => unknown,
      ) =>
        // `then` so a hook that throws is a rejected statement, as a failed
        // query is.
        Promise.resolve()
          .then(() => hook(q.text, q.params))
          .then(() => q)
          .then(onFulfilled, onRejected),
    };
  }) as unknown as Db;
}

const plainDb = (): Db => neonOverPglite(pg) as unknown as Db;

/** One run of one table's repair, as a cron process starting at `slot` UTC. */
async function run(
  table: FlowRepairTable,
  opts: { slot?: string; today?: string; db?: Db } = {},
): Promise<FlowRepairOutcome> {
  const today = opts.today ?? TODAY;
  const startTimeMs =
    Date.parse(`${today}T${opts.slot ?? '21:40'}:00Z`) + runs * 1_000;
  runs += 1;
  loaderClock += 61_000;
  vi.setSystemTime(loaderClock);
  await loadLotteryWeights();
  vi.setSystemTime(startTimeMs);
  return repairNullFlow(opts.db ?? plainDb(), {
    table,
    job: `enrich-${table}`,
    today,
    startTimeMs,
  });
}

interface Stored {
  ncp: string | null;
  npp: string | null;
  score: number | null;
  version: string | null;
}

async function stored(
  table: 'lottery_finder_fires' | 'silent_boom_alerts',
  id: number,
): Promise<Stored> {
  const extra =
    table === 'lottery_finder_fires'
      ? 'score, score_version AS version'
      : 'NULL::int AS score, NULL::text AS version';
  const r = await pg.query<Stored>(
    `SELECT cum_ncp_at_fire::text AS ncp, cum_npp_at_fire::text AS npp, ${extra}
       FROM ${table} WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

const lottery = (id: number) => stored('lottery_finder_fires', id);
const boom = (id: number) => stored('silent_boom_alerts', id);

/** META 2026-11-16: the same flow at both resolutions, as after the close. */
async function seedMeta(day = TODAY): Promise<void> {
  await insertWsTick(pg, 'META', `${day}T14:30:00.984Z`, 100, 10);
  await insertWsTick(pg, 'META', `${day}T14:30:31.250Z`, 50, 5);
  await insertWsTick(pg, 'META', `${day}T14:31:02.007Z`, 25, 2.5);
  await insertHistoryMinute(pg, 'META', `${day}T14:30:00Z`, 150, 15);
  await insertHistoryMinute(pg, 'META', `${day}T14:31:00Z`, 25, 2.5);
}

const seedFire = (over: Partial<LotterySeed> & { id: number }) =>
  seedLotteryFire(pg, {
    date: TODAY,
    at: `${TODAY}T15:00:00Z`,
    ...over,
  });

/** The score the live detector gives the default fire under `weights`. */
function liveScore(
  over: { optionType?: 'C' | 'P'; date?: string; ticker?: string },
  ncp: number,
  npp: number,
  weights: LotteryWeights = SEED_LOTTERY_WEIGHTS,
): number | null {
  const optionType = over.optionType ?? 'C';
  return scoreLotteryV2(weights, {
    ticker: over.ticker ?? 'META',
    tod: 'MID',
    dte: 0,
    volOiWindow: 0.4,
    gammaAtTrigger: 0.03,
    triggerAskPct: 0.8,
    optionType,
    isAligned: isAlignedFire(optionType, ncp, npp),
    dayOfWeek: weekdayOf(over.date ?? TODAY),
  });
}

/** Alarm messages sent, by their fixed fingerprint. */
const residualAlarms = () =>
  mockCaptureMessage.mock.calls.filter(
    ([, ctx]) => ctx?.fingerprint?.[0] === 'fire-flow-repair-residual',
  );

describe('repairNullFlow: the series and the write', () => {
  it('fills a NULL-flow lottery fire from the WS rows, not the WS plus history sum', async () => {
    await seedMeta();
    await seedFire({ id: 1 });

    const out = await run('lottery');

    expect(await lottery(1)).toMatchObject({ ncp: '175', npp: '17.5' });
    expect(out.status).toBe('success');
    expect(out.counts).toMatchObject({
      groups: 1,
      groupsDone: 1,
      fires: 1,
      written: 1,
      noValue: 0,
      notWritten: 0,
    });
  });

  it('fills a NULL-flow silent boom alert from the same series, and leaves lottery rows alone', async () => {
    await seedMeta();
    await seedFire({ id: 1 });
    await seedSilentBoom(pg, {
      id: 7,
      date: TODAY,
      at: `${TODAY}T14:31:00Z`,
    });

    const out = await run('silentboom');

    // The bucket is at 14:31:00: the last tick at or before it is 14:30:31.250.
    expect(await boom(7)).toMatchObject({ ncp: '150', npp: '15' });
    expect(await lottery(1)).toMatchObject({ ncp: null, npp: null });
    expect(out.counts).toMatchObject({ written: 1, scored: 0, scoredNull: 0 });
  });

  it('reads the flow at the fire, not the day total', async () => {
    await seedMeta();
    await seedFire({ id: 1, at: `${TODAY}T14:30:40Z` });

    await run('lottery');

    expect(await lottery(1)).toMatchObject({ ncp: '150', npp: '15' });
  });

  it('a history-only day uses the minutes complete at the fire (ts + 60 s), none from its own minute', async () => {
    await insertHistoryMinute(pg, 'IWM', `${TODAY}T14:30:00Z`, 100, 10);
    await insertHistoryMinute(pg, 'IWM', `${TODAY}T14:31:00Z`, 50, 5);
    await seedFire({ id: 1, ticker: 'IWM', at: `${TODAY}T14:31:30Z` });
    await seedFire({ id: 2, ticker: 'IWM', at: `${TODAY}T14:32:00Z` });

    await run('lottery');

    // 14:31:30 is inside the 14:31 minute: only the 14:30 minute is complete.
    expect(await lottery(1)).toMatchObject({ ncp: '100', npp: '10' });
    // 14:32:00 is the end of the 14:31 minute, which is now complete.
    expect(await lottery(2)).toMatchObject({ ncp: '150', npp: '15' });
  });

  it('never overwrites a value another writer stored between the read and the write', async () => {
    await seedMeta();
    await seedFire({ id: 1 });
    const db = intercept(async (text) => {
      if (text.includes('UPDATE lottery_finder_fires')) {
        await pg.query(
          `UPDATE lottery_finder_fires
              SET cum_ncp_at_fire = 999, cum_npp_at_fire = 1 WHERE id = 1`,
        );
      }
    });

    const out = await run('lottery', { slot: '23:40', db });

    expect(await lottery(1)).toMatchObject({ ncp: '999', npp: '1' });
    expect(out.counts).toMatchObject({
      written: 0,
      alreadyFilled: 1,
      notWritten: 0,
      residualFires: 0,
    });
    // The fire has its flow, so it is not residual and the day's alarm is quiet.
    expect(residualAlarms()).toHaveLength(0);
    expect(out.status).toBe('success');
  });

  it('writes 500 rows to a statement', async () => {
    await seedMeta();
    for (let id = 1; id <= 501; id += 1) {
      await seedFire({
        id,
        at: `${TODAY}T15:00:${String(id % 60).padStart(2, '0')}Z`,
      });
    }
    const updates: number[] = [];
    const db = intercept((text, params) => {
      if (text.includes('UPDATE lottery_finder_fires')) {
        updates.push((params[0] as string[]).length);
      }
    });

    const out = await run('lottery', { db });

    expect(updates).toEqual([500, 1]);
    expect(out.counts.written).toBe(501);
  });
});

describe('repairNullFlow: which fires are selected, and which are residual', () => {
  it('leaves a fire before the ticker first WS tick NULL, and it is not residual in the last slot', async () => {
    await seedMeta();
    // 08:30:00.500 CT: at the open, before META's first tick (14:30:00.984Z).
    await seedFire({ id: 1, at: `${TODAY}T14:30:00.500Z` });

    const out = await run('lottery', { slot: '23:40' });

    expect(await lottery(1)).toMatchObject({ ncp: null, npp: null });
    expect(out.counts).toMatchObject({
      groups: 1,
      fires: 1,
      written: 0,
      noValue: 1,
      residualFires: 0,
    });
    expect(out.status).toBe('success');
    expect(residualAlarms()).toHaveLength(0);
  });

  it('never selects a fire from before the open, and it is not residual', async () => {
    await seedMeta();
    await seedFire({ id: 1, at: `${TODAY}T14:29:59Z` });
    await seedSilentBoom(pg, { id: 7, date: TODAY, at: `${TODAY}T14:29:00Z` });

    const lotteryOut = await run('lottery', { slot: '23:40' });
    const boomOut = await run('silentboom', { slot: '23:45' });

    expect(lotteryOut.counts.groups).toBe(0);
    expect(boomOut.counts.groups).toBe(0);
    expect(await lottery(1)).toMatchObject({ ncp: null });
    expect(await boom(7)).toMatchObject({ ncp: null });
    expect(residualAlarms()).toHaveLength(0);
  });

  it('reads only the fires at or after the open of a ticker-day that also holds a pre-open fire', async () => {
    await seedMeta();
    await seedFire({ id: 1, at: `${TODAY}T14:29:59Z` });
    await seedFire({ id: 2 });

    const out = await run('lottery', { slot: '23:40' });

    expect(out.counts).toMatchObject({
      groups: 1,
      fires: 1,
      written: 1,
      noValue: 0,
      residualFires: 0,
    });
    expect(await lottery(1)).toMatchObject({ ncp: null });
    expect(await lottery(2)).toMatchObject({ ncp: '175' });
  });

  it('reads one series for a ticker-day, however many fires it holds', async () => {
    await seedMeta();
    await seedFire({ id: 1, at: `${TODAY}T14:30:40Z` });
    await seedFire({ id: 2, at: `${TODAY}T15:00:00Z` });
    await seedFire({ id: 3, at: `${TODAY}T16:00:00Z` });
    let seriesReads = 0;
    const db = intercept((text) => {
      if (text.includes('WITH unified')) seriesReads += 1;
    });

    const out = await run('lottery', { db });

    expect(seriesReads).toBe(1);
    expect(out.counts).toMatchObject({ groups: 1, fires: 3, written: 3 });
  });

  it('a ticker with no flow rows at all has nothing to write and is not residual', async () => {
    await seedFire({ id: 1, ticker: 'NOPE' });

    const out = await run('lottery', { slot: '23:40' });

    expect(out.counts).toMatchObject({
      noValue: 1,
      written: 0,
      residualFires: 0,
    });
    expect(residualAlarms()).toHaveLength(0);
  });

  it('covers today and the four days before it, and no earlier day', async () => {
    expect(FLOW_REPAIR_LOOKBACK_DAYS).toBe(4);
    expect(lookbackDates('2026-11-16')).toEqual([
      '2026-11-16',
      '2026-11-15',
      '2026-11-14',
      '2026-11-13',
      '2026-11-12',
    ]);
    for (const day of ['2026-11-11', '2026-11-12', '2026-11-16']) {
      await insertWsTick(pg, 'META', `${day}T14:30:00.100Z`, 10, 1);
    }
    await seedFire({ id: 1, date: '2026-11-11', at: '2026-11-11T15:00:00Z' });
    await seedFire({ id: 2, date: '2026-11-12', at: '2026-11-12T15:00:00Z' });
    await seedFire({ id: 3 });

    const out = await run('lottery');

    expect(out.counts.groups).toBe(2);
    expect(await lottery(1)).toMatchObject({ ncp: null });
    expect(await lottery(2)).toMatchObject({ ncp: '10' });
    expect(await lottery(3)).toMatchObject({ ncp: '10' });
  });

  it('works the newest date first, the ticker-day with the most NULL fires first within a date', async () => {
    await seedFire({ id: 1, date: '2026-11-13', at: '2026-11-13T15:00:00Z' });
    await seedFire({ id: 2, ticker: 'NVDA' });
    await seedFire({ id: 3, ticker: 'AMD' });
    await seedFire({ id: 4, ticker: 'AMD', at: `${TODAY}T15:01:00Z` });

    const groups = await selectNullFlowGroups(
      plainDb(),
      'lottery',
      lookbackDates(TODAY),
    );

    expect(groups).toEqual([
      { ticker: 'AMD', date: TODAY, nRows: 2 },
      { ticker: 'NVDA', date: TODAY, nRows: 1 },
      { ticker: 'META', date: '2026-11-13', nRows: 1 },
    ]);
  });

  // Every index on a fire table that leads with `date` serves the range (the
  // planner picks among them by cost: lottery_finder_fires_date_ts_idx,
  // _combined_score_idx, ... and silent_boom_alerts_date_bucket_idx, ...), so
  // the test pins the shape, not one index name: the date range is an INDEX
  // condition on the fire table, never a filter over a sequential scan.
  it.each(['lottery', 'silentboom'] as const)(
    'the %s selection bounds the fire table by an index condition on its date',
    async (table) => {
      let text = '';
      let params: unknown[] = [];
      const db = intercept((t, p) => {
        text = t;
        params = p;
      });
      await selectNullFlowGroups(db, table, lookbackDates(TODAY));
      // The planner prefers a sequential scan on a table this small; with it
      // off the plan shows whether the query CAN use a date index.
      await pg.query('SET enable_seqscan = off');

      const plan = (
        await pg.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (COSTS OFF) ${text}`,
          params,
        )
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');

      const fireTable =
        table === 'lottery' ? 'lottery_finder_fires' : 'silent_boom_alerts';
      expect(plan).not.toContain(`Seq Scan on ${fireTable}`);
      expect(plan).toMatch(
        new RegExp(`Index (Only )?Scan using \\w+ on ${fireTable}`),
      );
      expect(plan).toContain(
        "Index Cond: ((date >= '2026-11-12'::date) AND (date <= '2026-11-16'::date))",
      );
    },
  );
});

describe('repairNullFlow: the lottery re-score', () => {
  it('scores an aligned fire with the active weights and tags it with the active version', async () => {
    await seedMeta();
    await seedFire({ id: 1 });

    const out = await run('lottery');

    const row = await lottery(1);
    expect(row.score).toBe(liveScore({}, 175, 17.5));
    expect(row.score).toBeTypeOf('number');
    expect(row.version).toBe(SEED);
    expect(out.counts).toMatchObject({ scored: 1, scoredNull: 0 });
  });

  it('gives a fire against the flow score NULL and the active tag', async () => {
    await seedMeta();
    // A put fire needs net put premium over net call premium: 17.5 < 175.
    await seedFire({ id: 1, optionType: 'P', scoreVersion: 'older-version' });

    const out = await run('lottery');

    expect(liveScore({ optionType: 'P' }, 175, 17.5)).toBeNull();
    expect(await lottery(1)).toMatchObject({
      ncp: '175',
      npp: '17.5',
      score: null,
      version: SEED,
    });
    expect(out.counts).toMatchObject({ scored: 0, scoredNull: 1 });
  });

  it('scores with the version the active pointer names now, not the seed', async () => {
    await seedMeta();
    await seedFire({ id: 1 });
    await pg.query(
      `INSERT INTO lottery_score_versions (version, weights, status)
       VALUES ($1, $2::jsonb, 'promoted')`,
      [REFIT, JSON.stringify(REFIT_WEIGHTS)],
    );
    await pg.query(
      `UPDATE lottery_score_pointers SET version = $1 WHERE name = 'active'`,
      [REFIT],
    );

    await run('lottery');

    const row = await lottery(1);
    expect(row.version).toBe(REFIT);
    expect(row.score).toBe(liveScore({}, 175, 17.5, REFIT_WEIGHTS));
    expect(row.score).not.toBe(liveScore({}, 175, 17.5));
  });

  it('touches only the flow, the score and the tag', async () => {
    await seedMeta();
    await seedFire({ id: 1 });
    const columns = `to_jsonb(f) - 'cum_ncp_at_fire' - 'cum_npp_at_fire'
                       - 'score' - 'score_version' - 'combined_score'`;
    const before = await pg.query(
      `SELECT ${columns} AS row FROM lottery_finder_fires f`,
    );

    await run('lottery');

    const after = await pg.query(
      `SELECT ${columns} AS row FROM lottery_finder_fires f`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('writes the flow but leaves the score when the weights store cannot be read, and says so', async () => {
    await seedMeta();
    await seedFire({ id: 1 });
    await seedSilentBoom(pg, { id: 7, date: TODAY, at: `${TODAY}T15:00:00Z` });
    // No active pointer: the loader answers with its seed fallback.
    await pg.query('DELETE FROM lottery_score_pointers');

    const out = await run('lottery');

    expect(await lottery(1)).toMatchObject({
      ncp: '175',
      npp: '17.5',
      score: null,
      version: null,
    });
    expect(out.status).toBe('partial');
    expect(out.message).toContain('weights store could not be read');
    expect(out.counts).toMatchObject({
      written: 1,
      scored: 0,
      scoredNull: 0,
      rescoreSkipped: 1,
    });
    // Silent boom carries no score: the same store failure does not touch it.
    const boomOut = await run('silentboom');
    expect(boomOut.status).toBe('success');
    expect(await boom(7)).toMatchObject({ ncp: '175' });
  });

  it('does not re-score a fire from before the seed weights were live, nor one that already has a score', async () => {
    const day = '2026-09-07';
    await seedMeta(day);
    await seedMeta('2026-09-08');
    await seedFire({ id: 1, date: day, at: `${day}T14:45:00Z` });
    await seedFire({ id: 2, date: '2026-09-08', at: '2026-09-08T14:45:00Z' });
    await seedFire({
      id: 3,
      date: '2026-09-08',
      at: '2026-09-08T14:46:00Z',
      score: 99,
      scoreVersion: 'older-version',
    });

    const out = await run('lottery', { today: '2026-09-09' });

    // Before 2026-09-08: flow only, score and tag as they were.
    expect(await lottery(1)).toMatchObject({
      ncp: '175',
      score: null,
      version: null,
    });
    // On the seed day: scored.
    expect((await lottery(2)).score).toBe(
      liveScore({ date: '2026-09-08' }, 175, 17.5),
    );
    // Already scored: flow only.
    expect(await lottery(3)).toMatchObject({
      ncp: '175',
      score: 99,
      version: 'older-version',
    });
    expect(out.counts).toMatchObject({ scored: 1, scoreLeft: 2, written: 3 });
  });

  it('writes neither flow nor score when the active pointer moved after the weights were read, and a later slot repairs the row whole', async () => {
    await seedMeta();
    await seedFire({ id: 1 });
    await pg.query(
      `INSERT INTO lottery_score_versions (version, weights, status)
       VALUES ($1, $2::jsonb, 'promoted')`,
      [REFIT, JSON.stringify(REFIT_WEIGHTS)],
    );
    // The promotion lands after the loader read the seed and before the write.
    const db = intercept(async (text) => {
      if (text.includes('UPDATE lottery_finder_fires')) {
        await pg.query(
          `UPDATE lottery_score_pointers SET version = $1 WHERE name = 'active'`,
          [REFIT],
        );
      }
    });

    const first = await run('lottery', { slot: '23:40', db });

    // No row with flow and a score tagged with a version the pointer left.
    expect(await lottery(1)).toMatchObject({
      ncp: null,
      score: null,
      version: null,
    });
    expect(first.counts).toMatchObject({
      written: 0,
      notWritten: 1,
      residualFires: 1,
    });
    expect(first.status).toBe('partial');
    expect(residualAlarms()).toHaveLength(1);

    const second = await run('lottery', { slot: '23:40' });

    const row = await lottery(1);
    expect(row).toMatchObject({ ncp: '175', version: REFIT });
    expect(row.score).toBe(liveScore({}, 175, 17.5, REFIT_WEIGHTS));
    expect(second.status).toBe('success');
  });
});

describe('repairNullFlow: the time budget', () => {
  const TICKERS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];

  async function seedFiveGroups(): Promise<void> {
    for (const [i, ticker] of TICKERS.entries()) {
      await insertWsTick(pg, ticker, `${TODAY}T14:30:00.100Z`, 10, 1);
      await seedFire({ id: i + 1, ticker });
    }
  }

  /** Once a series read starts, the clock jumps to the step deadline. */
  const clockJumpsAtFirstSeriesRead = (startTimeMs: number): Db => {
    const deadline =
      startTimeMs + FLOW_REPAIR_CRON_MAX_DURATION_MS - FLOW_REPAIR_MARGIN_MS;
    return intercept((text) => {
      if (text.includes('WITH unified')) vi.setSystemTime(deadline);
    });
  };

  it('starts no new ticker-day once the deadline has passed, defers the rest, and the next slot finishes them', async () => {
    await seedFiveGroups();
    const startTimeMs = Date.parse(`${TODAY}T21:40:00Z`);

    const first = await run('lottery', {
      db: clockJumpsAtFirstSeriesRead(startTimeMs),
    });

    // Three groups were already started (the concurrency); two were not.
    expect(first.counts).toMatchObject({
      groups: 5,
      groupsDone: 3,
      groupsDeferred: 2,
      written: 3,
    });
    // A deferral is the budget doing its job, not a failure, until the last slot.
    expect(first.status).toBe('success');
    expect(first.counts.residualFires).toBe(2);

    const second = await run('lottery');

    expect(second.counts).toMatchObject({
      groups: 2,
      groupsDone: 2,
      written: 2,
    });
    for (let id = 1; id <= 5; id += 1) {
      expect((await lottery(id)).ncp).toBe('10');
    }
  });

  it('counts the ticker-days it could not start as residual in the last slot, with the alarm', async () => {
    await seedFiveGroups();
    const startTimeMs = Date.parse(`${TODAY}T23:40:00Z`);

    const out = await run('lottery', {
      slot: '23:40',
      db: clockJumpsAtFirstSeriesRead(startTimeMs),
    });

    expect(out.counts).toMatchObject({
      groupsDeferred: 2,
      residualFires: 2,
      residualGroups: 2,
      lastSlot: true,
    });
    expect(out.status).toBe('partial');
    expect(residualAlarms()).toHaveLength(1);
  });

  it('puts the deadline 60 s before the 300 s the crons are allowed', () => {
    expect(FLOW_REPAIR_CRON_MAX_DURATION_MS - FLOW_REPAIR_MARGIN_MS).toBe(
      240_000,
    );
  });
});

describe('repairNullFlow: failures', () => {
  beforeEach(async () => {
    await insertWsTick(pg, 'AAA', `${TODAY}T14:30:00.100Z`, 10, 1);
    await insertWsTick(pg, 'BBB', `${TODAY}T14:30:00.100Z`, 20, 2);
    await seedFire({ id: 1, ticker: 'AAA' });
    await seedFire({ id: 2, ticker: 'BBB' });
  });

  it('a failed series read makes the run partial, is captured, and the other ticker-days still repair', async () => {
    const db = intercept((text, params) => {
      if (text.includes('WITH unified') && params[0] === 'AAA') {
        throw new Error('relation "ws_net_flow_per_ticker" does not exist');
      }
    });

    const out = await run('lottery', { db });

    expect(await lottery(1)).toMatchObject({ ncp: null });
    expect(await lottery(2)).toMatchObject({ ncp: '20' });
    expect(out.status).toBe('partial');
    expect(out.message).toContain('1 ticker-day(s) could not be read');
    expect(out.counts).toMatchObject({ groupsReadFailed: 1, groupsDone: 1 });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0]![0]).toMatchObject({
      message: 'relation "ws_net_flow_per_ticker" does not exist',
    });
    expect(mockCaptureException.mock.calls[0]![1]).toMatchObject({
      tags: { job: 'enrich-lottery', table: 'lottery', kind: 'read' },
    });
  });

  it('a transient read failure is a warning message, still partial', async () => {
    const db = intercept((text) => {
      if (text.includes('WITH unified')) {
        throw new Error('Error connecting to database: fetch failed');
      }
    });

    const out = await run('lottery', { db });

    expect(out.status).toBe('partial');
    expect(out.counts.groupsReadFailed).toBe(2);
    expect(mockCaptureException).not.toHaveBeenCalled();
    // One message for the kind, however many ticker-days failed.
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![1]).toMatchObject({
      level: 'warning',
      fingerprint: ['fire-flow-repair-failure', 'lottery', 'read', 'transient'],
      extra: { failures: 2 },
    });
  });

  it('a series read past its deadline is a transient failure: partial, a warning message, no exception, and the other ticker-days still repair', async () => {
    const db = intercept((text, params) => {
      // Never answers: the read can only end by passing its deadline.
      if (text.includes('WITH unified') && params[0] === 'AAA') {
        return new Promise<void>(() => {});
      }
    });

    const out = await run('lottery', { db });

    expect(await lottery(1)).toMatchObject({ ncp: null });
    expect(await lottery(2)).toMatchObject({ ncp: '20' });
    expect(out.status).toBe('partial');
    expect(out.counts).toMatchObject({ groupsReadFailed: 1, groupsDone: 1 });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![1]).toMatchObject({
      level: 'warning',
      fingerprint: ['fire-flow-repair-failure', 'lottery', 'read', 'transient'],
      extra: { error: expect.stringContaining('deadline'), failures: 1 },
    });
  });

  it('a failed write is never reported as a success, is captured, and the rows stay NULL', async () => {
    const db = intercept((text) => {
      if (text.includes('UPDATE lottery_finder_fires')) {
        throw new Error('permission denied for table lottery_finder_fires');
      }
    });

    const out = await run('lottery', { db });

    expect(await lottery(1)).toMatchObject({ ncp: null });
    expect(await lottery(2)).toMatchObject({ ncp: null });
    expect(out.status).toBe('partial');
    expect(out.message).toContain('2 ticker-day(s) failed to write');
    expect(out.counts).toMatchObject({
      groupsWriteFailed: 2,
      written: 0,
      notWritten: 2,
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0]![1]).toMatchObject({
      tags: { kind: 'write' },
      extra: { failures: 2 },
    });
  });

  it('counts a row the write landed once, when the check on the rest then fails', async () => {
    await seedFire({ id: 3, ticker: 'AAA', at: `${TODAY}T15:01:00Z` });
    const db = intercept(async (text) => {
      if (text.includes('UPDATE lottery_finder_fires')) {
        // Another writer fills fire 1 first: the statement lands only fire 3.
        await pg.query(
          `UPDATE lottery_finder_fires
              SET cum_ncp_at_fire = 999, cum_npp_at_fire = 1 WHERE id = 1`,
        );
      }
      if (text.includes('id = ANY(')) throw new Error('permission denied');
    });

    const out = await run('lottery', { db });

    expect(await lottery(3)).toMatchObject({ ncp: '10' });
    expect(out.status).toBe('partial');
    // Fire 3 landed (written); fire 1 is the one the failed check left unknown.
    expect(out.counts).toMatchObject({
      groupsWriteFailed: 1,
      written: 2,
      notWritten: 1,
    });
  });

  it('a failed selection is partial and captured, and in the last slot it raises the alarm too', async () => {
    const db = intercept((text) => {
      if (text.includes('GROUP BY f.underlying_symbol')) {
        throw new Error('syntax error at or near "FROM"');
      }
    });

    const early = await run('lottery', { db });
    expect(early.status).toBe('partial');
    expect(early.counts).toMatchObject({ selectFailed: true, groups: 0 });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(residualAlarms()).toHaveLength(0);

    const last = await run('lottery', { slot: '23:40', db });
    expect(last.status).toBe('partial');
    expect(residualAlarms()).toHaveLength(1);
    expect(residualAlarms()[0]![1].extra).toMatchObject({ selectFailed: true });
  });
});

describe('repairNullFlow: the residual alarm', () => {
  beforeEach(async () => {
    await insertWsTick(pg, 'AAA', `${TODAY}T14:30:00.100Z`, 10, 1);
    await seedFire({ id: 1, ticker: 'AAA' });
  });

  const readFails = (): Db =>
    intercept((text) => {
      if (text.includes('WITH unified')) throw new Error('boom');
    });

  it('fires once, in the last slot only, with a fixed fingerprint per table', async () => {
    const early = await run('lottery', { slot: '22:40', db: readFails() });
    const lastLottery = await run('lottery', {
      slot: '23:40',
      db: readFails(),
    });

    expect(early.counts).toMatchObject({ lastSlot: false, residualFires: 1 });
    expect(lastLottery.counts).toMatchObject({
      lastSlot: true,
      residualFires: 1,
    });
    expect(residualAlarms()).toHaveLength(1);
    const [message, ctx] = residualAlarms()[0]!;
    expect(message).toContain('left fires without flow');
    expect(ctx).toMatchObject({
      level: 'error',
      fingerprint: ['fire-flow-repair-residual', 'lottery'],
      tags: { job: 'enrich-lottery', table: 'lottery' },
      extra: { date: TODAY, residualFires: 1, residualGroups: 1 },
    });
    expect(ctx.extra.sample).toEqual(['AAA (read-failed, 1)']);

    await seedSilentBoom(pg, {
      id: 7,
      ticker: 'AAA',
      date: TODAY,
      at: `${TODAY}T15:00:00Z`,
    });
    await run('silentboom', { slot: '23:45', db: readFails() });
    expect(residualAlarms()).toHaveLength(2);
    expect(residualAlarms()[1]![1].fingerprint).toEqual([
      'fire-flow-repair-residual',
      'silentboom',
    ]);
  });

  it('counts only the current date: an older date was alarmed at its own last slot', async () => {
    await insertWsTick(pg, 'AAA', '2026-11-13T14:30:00.100Z', 10, 1);
    await seedFire({
      id: 2,
      ticker: 'AAA',
      date: '2026-11-13',
      at: '2026-11-13T15:00:00Z',
    });
    // Today's fire is repaired; only the older date's group fails to read.
    const db = intercept((text, params) => {
      if (
        text.includes('WITH unified') &&
        String(params[1]).startsWith('2026-11-13')
      ) {
        throw new Error('boom');
      }
    });

    const out = await run('lottery', { slot: '23:40', db });

    expect(out.counts).toMatchObject({ groupsReadFailed: 1, residualFires: 0 });
    expect(residualAlarms()).toHaveLength(0);
    // Still partial: the failure is not hidden, only not alarmed twice.
    expect(out.status).toBe('partial');
  });

  it('stays quiet when nothing is left, in the last slot', async () => {
    const out = await run('lottery', { slot: '23:40' });

    expect(out.status).toBe('success');
    expect(out.counts).toMatchObject({ lastSlot: true, residualFires: 0 });
    expect(residualAlarms()).toHaveLength(0);
  });
});
