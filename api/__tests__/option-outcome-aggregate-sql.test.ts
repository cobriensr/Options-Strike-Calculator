// @vitest-environment node

/**
 * REAL-SQL parity test for the per-fire outcome aggregate.
 *
 * buildOutcomeAggregateStatement re-implements the lottery exit policies
 * (including the path-dependent trail 30/10) as SQL window functions so the
 * enrichment crons never pull 40K-tick tapes into JS. A typo in that SQL
 * (a dropped FILTER, an off-by-one in the running max, a wrong tie order)
 * would silently corrupt every enriched outcome while the cron tests, which
 * mock the driver, stay green. This test runs the EXACT production statement
 * against pglite (real Postgres in WASM) and checks every outcome against
 * the canonical JS policies of lottery-exit-policies.ts over the same ticks
 * in (executed_at, id) order.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import {
  buildContinuityGapStatement,
  buildOutcomeAggregateStatement,
  classifyAggregate,
  realizedFromAggregate,
  type OutcomeAggregateRow,
  type OutcomeWindow,
  type RealizedOutcomes,
} from '../_lib/option-outcome-aggregate.js';
import {
  minutesToPeak,
  peakCeiling,
  realizedHardStop30m,
  realizedTier50HoldEod,
  realizedTrailAct30Trail10,
} from '../_lib/lottery-exit-policies.js';

const CREATE_TABLE = `
  CREATE TABLE ws_option_trades (
    id BIGSERIAL PRIMARY KEY,
    ticker TEXT NOT NULL,
    option_chain TEXT NOT NULL,
    executed_at TIMESTAMPTZ NOT NULL,
    price NUMERIC NOT NULL,
    canceled BOOLEAN NOT NULL DEFAULT FALSE
  )
`;

/** 2026-10-01 (EDT): close 20:00Z, tail from 19:50Z, tape end 20:15Z. */
const DATE = '2026-10-01';
const TAIL_START = new Date('2026-10-01T19:50:00Z');
const TAPE_END = new Date('2026-10-01T20:15:00Z');

interface Tick {
  /** Minutes after 13:30Z (09:30 ET). */
  min: number;
  px: number;
  canceled?: boolean;
}

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.query(CREATE_TABLE);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('TRUNCATE ws_option_trades RESTART IDENTITY');
});

const at = (min: number): Date =>
  new Date(Date.UTC(2026, 9, 1, 13, 30) + Math.round(min * 60_000));

async function insertTicks(
  chain: string,
  ticker: string,
  ticks: readonly Tick[],
): Promise<void> {
  for (const t of ticks) {
    await db.query(
      `INSERT INTO ws_option_trades (ticker, option_chain, executed_at, price, canceled)
       VALUES ($1, $2, $3::timestamptz, $4::numeric, $5)`,
      [ticker, chain, at(t.min).toISOString(), t.px, t.canceled ?? false],
    );
  }
}

function windowFor(
  id: number,
  chain: string,
  ticker: string,
  entryMin: number,
  entryPx: number,
): OutcomeWindow {
  return {
    id,
    chain,
    ticker,
    date: DATE,
    entry: at(entryMin),
    entryPx,
    tailStart: TAIL_START,
    tapeEnd: TAPE_END,
  };
}

async function runAggregate(
  windows: OutcomeWindow[],
): Promise<Map<number, OutcomeAggregateRow>> {
  const { text, params } = buildOutcomeAggregateStatement(windows);
  const res = await db.query<OutcomeAggregateRow>(text, params);
  return new Map(res.rows.map((r) => [Number(r.window_id), r]));
}

/**
 * The oracle: the canonical JS policies over the ticks the SQL should see,
 * i.e. same chain, not canceled, price > 0, entry <= t <= tape end, ordered
 * by (executed_at, insertion id).
 */
function oracle(
  ticks: readonly Tick[],
  entryMin: number,
  entryPx: number,
): RealizedOutcomes {
  const entryMs = at(entryMin).getTime();
  const seen = ticks
    .map((t, i) => ({ ...t, i, ms: at(t.min).getTime() }))
    .filter(
      (t) =>
        !t.canceled &&
        t.px > 0 &&
        t.ms >= entryMs &&
        t.ms <= TAPE_END.getTime(),
    )
    .sort((a, b) => a.ms - b.ms || a.i - b.i);
  const prices = seen.map((t) => t.px);
  const mins = seen.map((t) => (t.ms - entryMs) / 60_000);
  const atHorizon = (h: number): number | null => {
    let last = -1;
    for (let i = 0; i < mins.length; i++) {
      if (mins[i]! <= h) last = i;
      else break;
    }
    return last === -1 ? null : ((prices[last]! - entryPx) / entryPx) * 100;
  };
  return {
    peakPct: peakCeiling(prices, entryPx),
    minutesToPeak: minutesToPeak(prices, mins),
    eodPct: ((prices.at(-1)! - entryPx) / entryPx) * 100,
    trail30_10Pct: realizedTrailAct30Trail10(prices, entryPx),
    hard30mPct: realizedHardStop30m(prices, entryPx, mins),
    tier50Pct: realizedTier50HoldEod(prices, entryPx),
    r30Pct: atHorizon(30),
    r60Pct: atHorizon(60),
    r120Pct: atHorizon(120),
  };
}

function realizedOf(
  row: OutcomeAggregateRow | undefined,
  entryPx: number,
): RealizedOutcomes {
  const verdict = classifyAggregate(row);
  if (verdict.kind !== 'priced') {
    throw new Error(`expected a priced aggregate, got ${verdict.kind}`);
  }
  return realizedFromAggregate(verdict.agg, entryPx);
}

function expectParity(actual: RealizedOutcomes, expected: RealizedOutcomes) {
  const { minutesToPeak: actualMin, ...actualRest } = actual;
  const { minutesToPeak: expectedMin, ...expectedRest } = expected;
  // Prices are selected, then priced by the same JS formula: bit-identical.
  expect(actualRest).toEqual(expectedRest);
  // epoch-seconds / 60 in SQL vs ms / 60000 in JS: equal to ~1e-9 min.
  expect(actualMin).toBeCloseTo(expectedMin, 9);
}

/**
 * Keep the ticker's close tail live: one print inside [19:50Z, 20:15Z] on a
 * sibling contract of the same ticker (never on the fired contract).
 */
async function markTailLive(ticker: string): Promise<void> {
  await insertTicks(`${ticker}-SIBLING`, ticker, [{ min: 385, px: 0.5 }]);
}

describe('buildOutcomeAggregateStatement (pglite)', () => {
  it('arms the trail at +30%, exits at running-max - 10pp, and prices every policy', async () => {
    const ticks: Tick[] = [
      { min: 0, px: 1.0 }, // entry print
      { min: 5, px: 1.1 },
      { min: 10, px: 1.35 }, // arms (r = 35)
      { min: 20, px: 1.5 }, // tier1 (r = 50), running max 50
      { min: 25, px: 1.45 }, // r 45 > 40: hold
      { min: 40, px: 1.39 }, // r 39 <= 40: trail exit
      { min: 90, px: 1.8 }, // peak after the exit
      { min: 200, px: 1.2 }, // last print = EOD
    ];
    await insertTicks('AAA261002C00100000', 'AAA', ticks);
    await markTailLive('AAA');
    const rows = await runAggregate([
      windowFor(1, 'AAA261002C00100000', 'AAA', 0, 1.0),
    ]);

    const got = realizedOf(rows.get(1), 1.0);
    expectParity(got, oracle(ticks, 0, 1.0));
    expect(got.trail30_10Pct).toBeCloseTo(39, 9);
    expect(got.tier50Pct).toBeCloseTo((50 + 20) / 2, 9);
    expect(got.peakPct).toBeCloseTo(80, 9);
    expect(got.minutesToPeak).toBeCloseTo(90, 9);
    expect(got.hard30mPct).toBeCloseTo(45, 9); // last print <= +30 min
  });

  it('rides to the last print when the trail never arms or never exits', async () => {
    const neverArms: Tick[] = [
      { min: 0, px: 2.0 },
      { min: 10, px: 2.4 },
      { min: 50, px: 1.6 },
      { min: 120, px: 2.1 },
    ];
    const armsNoExit: Tick[] = [
      { min: 1, px: 1.0 },
      { min: 15, px: 1.4 },
      { min: 60, px: 1.45 },
      { min: 70, px: 1.36 },
    ];
    await insertTicks('BBB261002C00050000', 'BBB', neverArms);
    await markTailLive('BBB');
    await insertTicks('BBB261002C00055000', 'BBB', armsNoExit);
    const rows = await runAggregate([
      windowFor(2, 'BBB261002C00050000', 'BBB', 0, 2.0),
      windowFor(3, 'BBB261002C00055000', 'BBB', 1, 1.0),
    ]);

    expectParity(realizedOf(rows.get(2), 2.0), oracle(neverArms, 0, 2.0));
    expectParity(realizedOf(rows.get(3), 1.0), oracle(armsNoExit, 1, 1.0));
    expect(realizedOf(rows.get(2), 2.0).trail30_10Pct).toBeCloseTo(5, 9);
  });

  it('excludes canceled, zero-price, pre-entry and post-tape-end prints', async () => {
    const ticks: Tick[] = [
      { min: -5, px: 9.0 }, // before entry
      { min: 0, px: 1.0 },
      { min: 3, px: 7.0, canceled: true }, // canceled spike
      { min: 4, px: 0 }, // zero price
      { min: 30, px: 1.2 },
      { min: 400, px: 1.1 }, // 20:10Z, inside the late-print allowance
      { min: 2000, px: 9.9 }, // next day: past the explicit upper bound
    ];
    await insertTicks('CCC261009P00020000', 'CCC', ticks);
    await markTailLive('CCC');
    const rows = await runAggregate([
      windowFor(4, 'CCC261009P00020000', 'CCC', 0, 1.0),
    ]);

    const got = realizedOf(rows.get(4), 1.0);
    expectParity(got, oracle(ticks, 0, 1.0));
    expect(got.peakPct).toBeCloseTo(20, 9);
    expect(got.eodPct).toBeCloseTo(10, 9);
    expect(rows.get(4)?.ticks).toBe(3);
  });

  it('returns 0 hard-stop and NULL horizons when nothing printed in them', async () => {
    // Silent-boom shape: the window starts at a bucket boundary, the first
    // print lands at +31 min.
    const ticks: Tick[] = [
      { min: 31, px: 1.3 },
      { min: 61, px: 1.6 },
      { min: 150, px: 1.1 },
    ];
    await insertTicks('DDD261002C00010000', 'DDD', ticks);
    await markTailLive('DDD');
    const rows = await runAggregate([
      windowFor(5, 'DDD261002C00010000', 'DDD', 0, 1.0),
    ]);

    const got = realizedOf(rows.get(5), 1.0);
    expectParity(got, oracle(ticks, 0, 1.0));
    expect(got.hard30mPct).toBe(0);
    expect(got.r30Pct).toBeNull();
    expect(got.r60Pct).toBeCloseTo(30, 9);
    expect(got.r120Pct).toBeCloseTo(60, 9);
  });

  it('breaks same-timestamp ties by insertion order, like the tick stream', async () => {
    const ticks: Tick[] = [
      { min: 0, px: 1.0 },
      { min: 10, px: 1.5 }, // arms + tier1
      { min: 10, px: 1.3 }, // same instant, later id: r 30 <= 40 → exit
      { min: 10, px: 1.6 },
      { min: 20, px: 1.0 },
    ];
    await insertTicks('EEE261002C00030000', 'EEE', ticks);
    await markTailLive('EEE');
    const rows = await runAggregate([
      windowFor(6, 'EEE261002C00030000', 'EEE', 0, 1.0),
    ]);

    const got = realizedOf(rows.get(6), 1.0);
    expectParity(got, oracle(ticks, 0, 1.0));
    expect(got.trail30_10Pct).toBeCloseTo(30, 9);
  });

  it('flags a quiet ticker tail as tapeGap and a live ticker with no contract prints as noPrints', async () => {
    // GAP: the feed died at 18:00Z, nothing in the tail.
    await insertTicks('GAP261002C00010000', 'GAP', [
      { min: 0, px: 1.0 },
      { min: 200, px: 1.4 },
    ]);
    // LIV: ticker live into the close, but nothing on the fired contract.
    await markTailLive('LIV');
    const rows = await runAggregate([
      windowFor(7, 'GAP261002C00010000', 'GAP', 0, 1.0),
      windowFor(8, 'LIV261002C00010000', 'LIV', 0, 1.0),
    ]);

    expect(classifyAggregate(rows.get(7))).toEqual({ kind: 'tapeGap' });
    expect(classifyAggregate(rows.get(8))).toEqual({ kind: 'noPrints' });
    expect(rows.get(8)?.ticks).toBe(0);
  });

  it('returns one row per window when several fires share a chain', async () => {
    const ticks: Tick[] = [
      { min: 0, px: 1.0 },
      { min: 30, px: 1.6 },
      { min: 60, px: 1.2 },
      { min: 90, px: 2.0 },
      { min: 300, px: 1.5 },
    ];
    await insertTicks('FFF261002C00040000', 'FFF', ticks);
    await markTailLive('FFF');
    const windows = [
      windowFor(10, 'FFF261002C00040000', 'FFF', 0, 1.0),
      windowFor(11, 'FFF261002C00040000', 'FFF', 30, 1.6),
      windowFor(12, 'FFF261002C00040000', 'FFF', 60, 1.2),
    ];
    const rows = await runAggregate(windows);

    expect(rows.size).toBe(3);
    expectParity(realizedOf(rows.get(10), 1.0), oracle(ticks, 0, 1.0));
    expectParity(realizedOf(rows.get(11), 1.6), oracle(ticks, 30, 1.6));
    expectParity(realizedOf(rows.get(12), 1.2), oracle(ticks, 60, 1.2));
  });

  it('matches the JS policies on randomized tapes (seeded property test)', async () => {
    // mulberry32: deterministic so a failure reproduces.
    let seed = 0x5eed1234;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const cases: Array<{
      window: OutcomeWindow;
      ticks: Tick[];
      entryMin: number;
    }> = [];
    for (let c = 0; c < 30; c++) {
      const chain = `RND2610${String(c).padStart(2, '0')}C00001000`;
      const entryMin = Math.floor(rand() * 300);
      const entryPx = Math.round((0.2 + rand() * 5) * 100) / 100;
      const ticks: Tick[] = [{ min: entryMin, px: entryPx }];
      let px = entryPx;
      let min = entryMin;
      const n = 20 + Math.floor(rand() * 120);
      for (let i = 0; i < n; i++) {
        // Ties (same minute) ~15% of the time; whole-cent prices.
        if (rand() > 0.15) min += rand() * 4;
        px = Math.max(0.01, px * (1 + (rand() - 0.45) * 0.25));
        ticks.push({
          min,
          px: Math.round(px * 100) / 100,
          canceled: rand() < 0.05,
        });
      }
      await insertTicks(chain, 'RND', ticks);
      cases.push({
        window: windowFor(100 + c, chain, 'RND', entryMin, entryPx),
        ticks,
        entryMin,
      });
    }

    await markTailLive('RND');

    const rows = await runAggregate(cases.map((c) => c.window));
    for (const c of cases) {
      expectParity(
        realizedOf(rows.get(c.window.id), c.window.entryPx),
        oracle(c.ticks, c.entryMin, c.window.entryPx),
      );
    }
  });
});

describe('buildContinuityGapStatement (pglite)', () => {
  it('lists exactly the empty 5-min buckets of each (ticker, date) session', async () => {
    // CONT prints once in every bucket of the 13:30Z-20:00Z session except
    // the one starting 16:00Z (minute 150). FULL prints in every bucket.
    const everyBucket = Array.from({ length: 78 }, (_, i) => i * 5 + 2);
    await insertTicks(
      'CONT261002C00010000',
      'CONT',
      everyBucket.filter((m) => m !== 152).map((min) => ({ min, px: 1 })),
    );
    await insertTicks(
      'FULL261002C00010000',
      'FULL',
      everyBucket.map((min) => ({ min, px: 1 })),
    );
    const session = {
      date: DATE,
      openAt: new Date('2026-10-01T13:30:00Z'),
      closeAt: new Date('2026-10-01T20:00:00Z'),
    };

    const { text, params } = buildContinuityGapStatement([
      { ticker: 'CONT', ...session },
      { ticker: 'FULL', ...session },
      { ticker: 'NONE', ...session, closeAt: new Date('2026-10-01T13:40:00Z') },
    ]);
    const res = await db.query<{
      ticker: string;
      date: string;
      gap_start: Date;
    }>(text, params);

    expect(
      res.rows.map((r) => [
        r.ticker,
        r.date,
        new Date(r.gap_start).toISOString(),
      ]),
    ).toEqual([
      ['CONT', DATE, '2026-10-01T16:00:00.000Z'],
      // A ticker with no prints at all: every bucket of its (short) session.
      ['NONE', DATE, '2026-10-01T13:30:00.000Z'],
      ['NONE', DATE, '2026-10-01T13:35:00.000Z'],
    ]);
  });
});
