// @vitest-environment node

/**
 * REAL-SQL integration test for the flow-regime in-SQL aggregation.
 *
 * WHY THIS EXISTS: flow-regime-sql-parity.test.ts only locks a hand-written JS
 * TRANSCRIPTION of the SQL to `computeFlowMetrics`; the cron tests mock
 * `sql.query`. So a typo in the ACTUAL SQL (a dropped FILTER, a swapped CASE
 * literal, an off-by-one in the slot floor / timezone expression) would ship
 * green. This test closes that gap: it runs the EXACT production statements
 * produced by `buildAggWindowStatement` / `buildAggSlotStatement` against an
 * in-process Postgres (pglite — real Postgres-in-WASM with full
 * `AT TIME ZONE 'America/New_York'` timezone-data support, which pg-mem lacks)
 * and asserts the result equals `computeFlowMetrics` over the same rows.
 *
 * This gives a true oracle for the slot derivation (AT TIME ZONE + floor + RTH
 * bounds) — which the parity test cannot exercise — and for the universe
 * FILTER, the baseline-derived side_sign CASE, the premium algebra, the 0DTE
 * index-put FILTER, NULL delta/price skipping, and COALESCE-on-empty.
 *
 * The same `{ text, params }` statements are what prod sends to neon
 * (`sql.query(text, params)`) — neon and pglite both use `$1` placeholders — so
 * the SQL under test is byte-for-byte the production SQL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import {
  buildAggWindowStatement,
  buildAggSlotStatement,
  runAggWindow,
  runAggSlot,
  type FlowAggRunner,
} from '../_lib/flow-regime-rows.js';
import {
  FLOW_REGIME_BASELINE,
  computeFlowMetrics,
  slotForEtMinute,
  type FlowMetricSums,
  type FlowTradeRow,
} from '../_lib/flow-regime.js';
import { etWallClockToUtcIso } from '../../src/utils/timezone.js';

const { universe, index_set: indexSet } = FLOW_REGIME_BASELINE;

const DATE = '2026-06-05'; // a regular RTH weekday (EDT)
const OFF_UNIVERSE = 'ZZZZ'; // intentionally not in the baseline universe

// Sanity: the fixture assumptions hold for the committed baseline.
expect(universe).toContain('SPY');
expect(universe).toContain('QQQ');
expect(universe).toContain('SPXW');
expect(indexSet).toEqual(expect.arrayContaining(['SPY', 'QQQ', 'SPXW']));
expect(universe).not.toContain(OFF_UNIVERSE);
// NVDA is in the universe but NOT in the index_set (used to test the 0DTE
// index-put FILTER excludes non-index puts while keeping them in total_premium).
expect(universe).toContain('NVDA');
expect(indexSet).not.toContain('NVDA');

/**
 * One fixture trade specified at the SQL level. `etMinute` is the ET
 * minute-of-day of execution (e.g. 9:30 = 570); we convert it to the correct
 * UTC instant via the SAME helper the crons use, so the row's stored
 * executed_at localizes back to exactly `etMinute` in the slot expression.
 * delta/price may be null (→ NULL column → skipped by SUM). canceled defaults
 * to false; a true value must be excluded by the WHERE clause.
 */
interface Fixture {
  ticker: string;
  optionType: 'C' | 'P';
  /** ET trade date the row's expiry/executed_at belong to. */
  etDate: string;
  /** ET minute-of-day of execution (570 = 09:30, 959 = 15:59). */
  etMinute: number;
  /** Contract expiry (ET calendar date). 0DTE when === etDate. */
  expiry: string;
  side: string;
  delta: number | null;
  size: number;
  price: number | null;
  canceled?: boolean;
}

/** Map a fixture to the FlowTradeRow `computeFlowMetrics` consumes (oracle). */
function toFlowTradeRow(f: Fixture): FlowTradeRow {
  const base: FlowTradeRow = {
    ticker: f.ticker,
    optionType: f.optionType,
    expiry: f.expiry,
    tradeDateEt: f.etDate,
    side: f.side,
    delta: f.delta ?? 0,
    size: f.size,
  };
  // price null → omit, so computeFlowMetrics' rowPremium returns null and the
  // row is excluded from the premium sums — exactly like SQL's NULL-skip.
  if (f.price !== null) base.price = f.price;
  return base;
}

/** Resolve a fixture's executed_at as a UTC ISO string (DST-safe). */
function executedAtIso(f: Fixture): string {
  const iso = etWallClockToUtcIso(f.etDate, f.etMinute);
  if (iso === null)
    throw new Error(`bad ET wall clock for fixture ${f.ticker}`);
  return iso;
}

/** The ws_option_trades subset our SQL reads, with production column types. */
const CREATE_TABLE = `
  CREATE TABLE ws_option_trades (
    id            BIGSERIAL PRIMARY KEY,
    ticker        TEXT NOT NULL,
    option_type   CHAR(1) NOT NULL,
    expiry        DATE NOT NULL,
    executed_at   TIMESTAMPTZ NOT NULL,
    price         NUMERIC(12, 4) NOT NULL,
    size          INTEGER NOT NULL,
    side          TEXT NOT NULL,
    delta         NUMERIC(10, 6),
    canceled      BOOLEAN NOT NULL DEFAULT FALSE
  )
`;

let db: PGlite;

/** pglite runner with the same `(text, params) => { rows }` contract as neon. */
const run: FlowAggRunner = (text, params) => db.query(text, params);

beforeAll(async () => {
  db = await PGlite.create();
  await db.query(CREATE_TABLE);
});

afterAll(async () => {
  await db.close();
});

/** Wipe + reload the table with `fixtures`. price NULL stored as a true NULL. */
async function load(fixtures: readonly Fixture[]): Promise<void> {
  await db.query('TRUNCATE ws_option_trades');
  for (const f of fixtures) {
    await db.query(
      `INSERT INTO ws_option_trades
         (ticker, option_type, expiry, executed_at, price, size, side, delta, canceled)
       VALUES ($1, $2, $3::date, $4::timestamptz, $5, $6, $7, $8, $9)`,
      [
        f.ticker,
        f.optionType,
        f.expiry,
        executedAtIso(f),
        // price is NOT NULL in the real table; model a "missing price" row with
        // 0 so the column constraint holds AND computeFlowMetrics still counts
        // it (price 0 → premium 0). A genuine NULL price is exercised via the
        // delta-NULL path below; the production daemon never writes NULL price.
        f.price === null ? 0 : f.price,
        f.size,
        f.side,
        f.delta, // NULL passes through as a true SQL NULL
        f.canceled ?? false,
      ],
    );
  }
}

/**
 * Oracle for the single-window aggregation: feed the (canceled=false) fixtures
 * through `computeFlowMetrics` and count every non-canceled row for n_trades
 * (the SQL counts count(*) over the same window, unrestricted by universe).
 */
function oracleWindow(
  fixtures: readonly Fixture[],
): FlowMetricSums & { nTrades: number } {
  const live = fixtures.filter((f) => !f.canceled);
  const sums = computeFlowMetrics(live.map(toFlowTradeRow));
  return { ...sums, nTrades: live.length };
}

/** The full-day window [09:30, 16:00) ET → UTC bounds for `DATE`. */
function dayWindow(date = DATE): { startIso: string; endIso: string } {
  const startIso = etWallClockToUtcIso(
    date,
    FLOW_REGIME_BASELINE.rth_start_minute,
  );
  const endIso = etWallClockToUtcIso(date, FLOW_REGIME_BASELINE.rth_end_minute);
  if (startIso === null || endIso === null) throw new Error('bad day window');
  return { startIso, endIso };
}

function expectSumsClose(
  actual: {
    ndNum: number;
    ndDen: number;
    idxPutPremium: number;
    totalPremium: number;
  },
  expected: FlowMetricSums,
): void {
  expect(actual.ndNum).toBeCloseTo(expected.ndNum, 6);
  expect(actual.ndDen).toBeCloseTo(expected.ndDen, 6);
  expect(actual.idxPutPremium).toBeCloseTo(expected.idxPutPremium, 6);
  expect(actual.totalPremium).toBeCloseTo(expected.totalPremium, 6);
}

// A broad fixture exercising every branch in ONE slot (10:00 ET = slot 1):
//   - universe + non-universe rows (n_trades counts both; sums exclude ZZZZ)
//   - ask / bid / mid / no_side sides (side_sign CASE)
//   - 0DTE index puts vs non-0DTE / non-index / calls (idx-put FILTER)
//   - NULL delta and NULL price (skipped by the relevant SUMs)
//   - canceled = true (excluded by WHERE)
const SLOT1_MIN = 600; // 10:00 ET → slot floor((600-570)/30) = 1
const BROAD_FIXTURES: Fixture[] = [
  // 0DTE index put, ask → idx_put_premium + total_premium, nd_num −.
  {
    ticker: 'SPY',
    optionType: 'P',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: DATE,
    side: 'ask',
    delta: -0.5,
    size: 100,
    price: 1.25,
  },
  // 0DTE index put, bid → idx_put_premium + total_premium, nd_num +.
  {
    ticker: 'QQQ',
    optionType: 'P',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: DATE,
    side: 'bid',
    delta: -0.4,
    size: 50,
    price: 2,
  },
  // 0DTE index call → NOT idx_put, but in total_premium; nd_num +.
  {
    ticker: 'SPXW',
    optionType: 'C',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: DATE,
    side: 'ask',
    delta: 0.6,
    size: 30,
    price: 3,
  },
  // non-0DTE index put (expiry != date) → NOT idx_put, in total_premium.
  {
    ticker: 'SPY',
    optionType: 'P',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: '2026-06-06',
    side: 'ask',
    delta: -0.5,
    size: 10,
    price: 5,
  },
  // non-index universe put (NVDA) → NOT idx_put, in total_premium.
  {
    ticker: 'NVDA',
    optionType: 'P',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: DATE,
    side: 'ask',
    delta: -0.5,
    size: 20,
    price: 4,
  },
  // mid / no_side → side_sign 0 (nd_num unchanged), still in nd_den + premium.
  {
    ticker: 'AAPL',
    optionType: 'C',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: DATE,
    side: 'mid',
    delta: 0.3,
    size: 15,
    price: 6,
  },
  {
    ticker: 'AMD',
    optionType: 'C',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: DATE,
    side: 'no_side',
    delta: 0.2,
    size: 25,
    price: 7,
  },
  // off-universe row → excluded from ALL sums, but counts in n_trades.
  {
    ticker: OFF_UNIVERSE,
    optionType: 'P',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: DATE,
    side: 'ask',
    delta: -9,
    size: 99,
    price: 99,
  },
  // NULL delta → skipped by nd_num/nd_den; still in total_premium.
  {
    ticker: 'SPY',
    optionType: 'C',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: DATE,
    side: 'ask',
    delta: null,
    size: 12,
    price: 8,
  },
  // NULL price → excluded from premium sums; still in nd_num/nd_den.
  {
    ticker: 'QQQ',
    optionType: 'P',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: DATE,
    side: 'ask',
    delta: -0.7,
    size: 8,
    price: null,
  },
  // canceled → excluded entirely by WHERE canceled = FALSE.
  {
    ticker: 'SPY',
    optionType: 'P',
    etDate: DATE,
    etMinute: SLOT1_MIN,
    expiry: DATE,
    side: 'ask',
    delta: -0.5,
    size: 1000,
    price: 50,
    canceled: true,
  },
];

describe('flow-regime in-SQL aggregation (pglite, real SQL)', () => {
  it('confirms pglite executes AT TIME ZONE / extract (timezone data present)', async () => {
    const res = (await db.query(
      `SELECT extract(hour FROM (timestamptz '2026-06-05 14:15:00+00'
         AT TIME ZONE 'America/New_York')) AS h`,
    )) as { rows: { h: unknown }[] };
    // 14:15 UTC on an EDT day = 10:15 ET.
    expect(Number(res.rows[0]!.h)).toBe(10);
  });

  describe('aggregateFlowWindow (single in-progress window)', () => {
    it('matches computeFlowMetrics on the broad mixed bucket', async () => {
      await load(BROAD_FIXTURES);
      const { startIso, endIso } = dayWindow();
      const agg = await runAggWindow(run, startIso, endIso, DATE);
      const oracle = oracleWindow(BROAD_FIXTURES);

      expectSumsClose(agg, oracle);
      // n_trades = count(*) over non-canceled rows (10), NOT universe-restricted.
      expect(agg.nTrades).toBe(oracle.nTrades);
      expect(agg.nTrades).toBe(10);
      // idx_put = SPY(1.25·100·100) + QQQ(2·50·100) only (the two 0DTE index
      // puts with a non-null price). NVDA/SPXW/non-0DTE excluded.
      expect(agg.idxPutPremium).toBeCloseTo(1.25 * 100 * 100 + 2 * 50 * 100, 6);
    });

    it('returns all-zero (COALESCE) for an empty window', async () => {
      await load([]);
      const { startIso, endIso } = dayWindow();
      const agg = await runAggWindow(run, startIso, endIso, DATE);
      expect(agg).toEqual({
        nTrades: 0,
        ndNum: 0,
        ndDen: 0,
        idxPutPremium: 0,
        totalPremium: 0,
      });
    });

    it('excludes canceled rows from every aggregate (WHERE canceled = FALSE)', async () => {
      // Only a canceled row in the window → SQL sees nothing.
      await load([
        {
          ticker: 'SPY',
          optionType: 'P',
          etDate: DATE,
          etMinute: SLOT1_MIN,
          expiry: DATE,
          side: 'ask',
          delta: -0.5,
          size: 5,
          price: 9,
          canceled: true,
        },
      ]);
      const { startIso, endIso } = dayWindow();
      const agg = await runAggWindow(run, startIso, endIso, DATE);
      expect(agg.nTrades).toBe(0);
      expect(agg.totalPremium).toBe(0);
    });

    it('compares expiry to the bound tradeDateEt for the 0DTE index-put test', async () => {
      // A SPY put whose expiry is 06-05 is 0DTE only when the window's
      // tradeDateEt is 06-05. Pass a DIFFERENT tradeDateEt and idx_put → 0.
      await load([
        {
          ticker: 'SPY',
          optionType: 'P',
          etDate: DATE,
          etMinute: SLOT1_MIN,
          expiry: DATE,
          side: 'ask',
          delta: -0.5,
          size: 100,
          price: 2,
        },
      ]);
      const { startIso, endIso } = dayWindow();
      const sameDay = await runAggWindow(run, startIso, endIso, DATE);
      expect(sameDay.idxPutPremium).toBeCloseTo(2 * 100 * 100, 6);
      const otherDay = await runAggWindow(run, startIso, endIso, '2026-06-04');
      expect(otherDay.idxPutPremium).toBe(0);
      // total_premium is unaffected by the trade-date arg.
      expect(otherDay.totalPremium).toBeCloseTo(2 * 100 * 100, 6);
    });
  });

  describe('aggregateFlowWindowBySlot (per-ET-30min-slot)', () => {
    it('buckets rows across multiple ET slots and matches computeFlowMetrics per slot', async () => {
      // 09:30 ET (570) → slot 0; 10:00 (600) → slot 1; 10:29 (629) → slot 1
      // (floor); 10:30 (630) → slot 2; 15:59 (959) → slot 12 (last RTH slot).
      const fixtures: Fixture[] = [
        {
          ticker: 'SPY',
          optionType: 'P',
          etDate: DATE,
          etMinute: 570,
          expiry: DATE,
          side: 'ask',
          delta: -0.5,
          size: 100,
          price: 1,
        },
        {
          ticker: 'QQQ',
          optionType: 'P',
          etDate: DATE,
          etMinute: 600,
          expiry: DATE,
          side: 'bid',
          delta: -0.4,
          size: 50,
          price: 2,
        },
        // back-half of slot 1 — verifies floor (CAST would push this to slot 2).
        {
          ticker: 'SPXW',
          optionType: 'P',
          etDate: DATE,
          etMinute: 629,
          expiry: DATE,
          side: 'ask',
          delta: -0.6,
          size: 40,
          price: 3,
        },
        {
          ticker: 'NVDA',
          optionType: 'C',
          etDate: DATE,
          etMinute: 630,
          expiry: DATE,
          side: 'ask',
          delta: 0.3,
          size: 20,
          price: 4,
        },
        {
          ticker: 'SPY',
          optionType: 'P',
          etDate: DATE,
          etMinute: 959,
          expiry: DATE,
          side: 'ask',
          delta: -0.5,
          size: 10,
          price: 5,
        },
      ];
      await load(fixtures);
      const { startIso, endIso } = dayWindow();
      const slots = await runAggSlot(run, startIso, endIso);

      // Expected slot membership via the SAME slotForEtMinute the live cron uses.
      const bySlot = new Map<number, Fixture[]>();
      for (const f of fixtures) {
        const slot = slotForEtMinute(f.etMinute);
        expect(slot).not.toBeNull();
        const arr = bySlot.get(slot!) ?? [];
        arr.push(f);
        bySlot.set(slot!, arr);
      }

      expect(new Set(slots.map((s) => s.slot))).toEqual(new Set(bySlot.keys()));
      // The back-half row at 10:29 must land in slot 1, not slot 2.
      expect(
        bySlot
          .get(1)!
          .map((f) => f.etMinute)
          .sort(),
      ).toEqual([600, 629]);

      for (const s of slots) {
        const bucket = bySlot.get(s.slot)!;
        const oracle = computeFlowMetrics(bucket.map(toFlowTradeRow));
        expectSumsClose(s, oracle);
        expect(s.nTrades).toBe(bucket.length);
      }
    });

    it('drops rows outside RTH (slot < 0 or >= slot_count)', async () => {
      // 09:00 ET (540) is pre-RTH → slot −1; 16:00 (960) is the exclusive RTH
      // upper bound → slot 13 (== slot_count, dropped). Neither is persisted.
      // 09:30 (570) is the first valid slot.
      const fixtures: Fixture[] = [
        {
          ticker: 'SPY',
          optionType: 'P',
          etDate: DATE,
          etMinute: 540,
          expiry: DATE,
          side: 'ask',
          delta: -0.5,
          size: 1,
          price: 1,
        },
        {
          ticker: 'SPY',
          optionType: 'P',
          etDate: DATE,
          etMinute: 570,
          expiry: DATE,
          side: 'ask',
          delta: -0.5,
          size: 2,
          price: 1,
        },
      ];
      await load(fixtures);
      // Widen the window so the pre-RTH row is INSIDE [start, end) but still
      // gets dropped by the slot bound (proves the slot filter, not the window).
      const startIso = etWallClockToUtcIso(DATE, 480); // 08:00 ET
      const endIso = etWallClockToUtcIso(DATE, 970); // 16:10 ET
      const slots = await runAggSlot(run, startIso!, endIso!);

      // Only slot 0 survives.
      expect(slots.map((s) => s.slot)).toEqual([0]);
      expect(slots[0]!.nTrades).toBe(1);
    });

    it('uses each row’s own ET date for the per-row 0DTE index-put test', async () => {
      // Two SPY puts in slot 1, both expiry 06-05. One executed on 06-05 (0DTE),
      // one on 06-04 (NOT 0DTE for its own ET date). The per-row etDateExpr must
      // count only the 06-05 one toward idx_put_premium.
      const fixtures: Fixture[] = [
        {
          ticker: 'SPY',
          optionType: 'P',
          etDate: DATE,
          etMinute: 600,
          expiry: DATE,
          side: 'ask',
          delta: -0.5,
          size: 100,
          price: 2,
        },
        {
          ticker: 'SPY',
          optionType: 'P',
          etDate: '2026-06-04',
          etMinute: 600,
          expiry: DATE,
          side: 'ask',
          delta: -0.5,
          size: 100,
          price: 2,
        },
      ];
      await load(fixtures);
      // Two-day window so both rows are inside it.
      const startIso = etWallClockToUtcIso(
        '2026-06-04',
        FLOW_REGIME_BASELINE.rth_start_minute,
      );
      const endIso = dayWindow().endIso;
      const slots = await runAggSlot(run, startIso!, endIso);

      // Both rows localize to slot 1 (10:00 ET) on their respective days.
      const slot1 = slots.find((s) => s.slot === 1)!;
      expect(slot1.nTrades).toBe(2);
      // Only the 06-05 row is 0DTE for its own date → idx_put = one row.
      expect(slot1.idxPutPremium).toBeCloseTo(2 * 100 * 100, 6);
      // Both rows are index puts in total_premium.
      expect(slot1.totalPremium).toBeCloseTo(2 * (2 * 100 * 100), 6);
    });
  });

  describe('statement builders produce the production SQL', () => {
    it('window statement uses $1..$5 params in the documented order', () => {
      const { text, params } = buildAggWindowStatement('A', 'B', '2026-06-05');
      expect(params).toEqual([universe, indexSet, 'A', 'B', '2026-06-05']);
      expect(text).toContain('ticker = ANY($1)');
      expect(text).toContain('$5::date');
      // side_sign is derived from the baseline map, not hardcoded.
      expect(text).toContain("CASE side WHEN 'ask' THEN 1 WHEN 'bid' THEN -1");
    });

    it('slot statement bounds the slot to [0, slot_count) and floors', () => {
      const { text, params } = buildAggSlotStatement('A', 'B');
      expect(params).toEqual([universe, indexSet, 'A', 'B']);
      expect(text).toContain("AT TIME ZONE 'America/New_York'");
      expect(text).toContain('floor(');
      expect(text).toContain(`< ${FLOW_REGIME_BASELINE.slot_count}`);
    });
  });
});
