// @vitest-environment node

/**
 * SQL ↔ JS parity for the flow-regime metric reduction.
 *
 * The two flow-regime crons push the metric reduction INTO SQL (the shared
 * `aggregateFlowWindow` / `aggregateFlowWindowBySlot` builders in
 * flow-regime-rows.ts) so the raw ws_option_trades rows never serialize past
 * Neon's 64MB HTTP cap. The SQL FILTER/SUM/COALESCE algebra MUST stay
 * numerically identical to the JS reducer `computeFlowMetrics`
 * (api/_lib/flow-regime.ts), which is the semantic source of truth and the
 * basis the committed baseline was built on (consistency rule).
 *
 * SCOPE / LIMITATION: this test does NOT execute the real SQL string — there
 * is no live DB in unit tests. It locks the equivalence of a hand-written JS
 * TRANSCRIPTION of the SQL algebra to `computeFlowMetrics`; a typo in the
 * actual SQL in flow-regime-rows.ts would not be caught here (the cron tests
 * assert the query's params + key substrings, not the FILTER algebra). The
 * value is keeping the INTENDED algebra pinned to the source of truth so a
 * future edit to either side must consciously update both. It builds a fixture
 * of trade rows and computes the four component sums two ways —
 *   (a) `computeFlowMetrics(rows)` — the JS source of truth.
 *   (b) `sqlReplica(rows)` — a pure-JS replica of the SQL's per-column
 *       FILTER (WHERE ticker = ANY(universe) ...) SUM(...) COALESCE(..., 0)
 *       logic, including:
 *         - universe restriction on every SUM (rows outside excluded),
 *         - side_sign CASE map derived from FLOW_REGIME_BASELINE.side_sign_map
 *           (NOT re-hardcoded), so a baseline regen that changes the map can't
 *           silently desync this replica from the SQL/JS reducer,
 *         - premium = price·size·100,
 *         - the 0DTE index-put FILTER (index_set AND option_type='P' AND
 *           expiry = trade date),
 *         - NULL delta / price contributing 0 (SQL SUM skips NULLs),
 *         - COALESCE turning an all-empty window into 0, not NULL,
 *       and n_trades = count(*) over ALL rows (NOT universe-restricted), which
 *       matches the JS reducer's `rows.length`.
 * — then asserts they're equal.
 */

import { describe, it, expect } from 'vitest';

import {
  FLOW_REGIME_BASELINE,
  computeFlowMetrics,
  type FlowMetricSums,
  type FlowTradeRow,
} from '../_lib/flow-regime.js';

const {
  universe,
  index_set: indexSet,
  side_sign_map: sideSignMap,
} = FLOW_REGIME_BASELINE;

/**
 * A row as the cron sees it AFTER Neon coercion but modeled here at the SQL
 * level: delta/price may be null (NULL in the column → skipped by SUM).
 */
interface RawRow {
  ticker: string;
  optionType: string;
  expiry: string;
  tradeDateEt: string;
  side: string;
  delta: number | null;
  size: number;
  price: number | null;
}

/**
 * Pure-JS replica of the SQL aggregation in `aggregateFlowWindow` /
 * `aggregateFlowWindowBySlot`. Mirrors each FILTER (WHERE ...) SUM(...)
 * COALESCE(..., 0) column and the unfiltered count(*). Returns the four
 * component sums + n_trades.
 */
function sqlReplica(rows: readonly RawRow[]): FlowMetricSums & {
  nTrades: number;
} {
  const universeSet = new Set(universe);
  const indexSetSet = new Set(indexSet);

  // count(*) over the window — NOT universe-restricted.
  const nTrades = rows.length;

  let ndNum = 0;
  let ndDen = 0;
  let totalPremium = 0;
  let idxPutPremium = 0;

  for (const r of rows) {
    // Every SUM is FILTERed on the universe.
    if (!universeSet.has(r.ticker)) continue;

    // side_sign CASE map — derived from FLOW_REGIME_BASELINE.side_sign_map,
    // NOT re-hardcoded, so this replica tracks a baseline regen in lockstep
    // with `sideSign` in flow-regime.ts and the SQL builder's `sideSignCase`.
    const sign = sideSignMap[r.side] ?? 0;

    // SUM skips NULL delta (the multiplicative terms drop out → +0).
    if (r.delta !== null) {
      ndNum += sign * r.delta * r.size;
      ndDen += Math.abs(r.delta) * r.size;
    }

    // premium = price·size·100; SUM skips NULL price (→ +0).
    if (r.price !== null) {
      const premium = r.price * r.size * 100;
      totalPremium += premium;

      // 0DTE index-put FILTER: index_set AND option_type='P' AND expiry=date.
      if (
        indexSetSet.has(r.ticker) &&
        r.optionType === 'P' &&
        r.expiry === r.tradeDateEt
      ) {
        idxPutPremium += premium;
      }
    }
  }

  // COALESCE(..., 0) — the loop already starts at 0, matching an empty window.
  return { ndNum, ndDen, idxPutPremium, totalPremium, nTrades };
}

/**
 * Coerce a SQL-level RawRow (delta/price may be null) to a FlowTradeRow the JS
 * reducer accepts. This mirrors `toFlowTradeRow`'s coercion: delta null → 0,
 * price null → omitted (so computeFlowMetrics' rowPremium returns null and the
 * row is excluded from the premium sums, exactly like the SQL's NULL-skip).
 */
function toFlowTradeRow(r: RawRow): FlowTradeRow {
  const base: FlowTradeRow = {
    ticker: r.ticker,
    optionType: r.optionType,
    expiry: r.expiry,
    tradeDateEt: r.tradeDateEt,
    side: r.side,
    delta: r.delta ?? 0,
    size: r.size,
  };
  if (r.price !== null) base.price = r.price;
  return base;
}

const DATE = '2026-06-05';

function row(o: Partial<RawRow> = {}): RawRow {
  return {
    ticker: 'SPY',
    optionType: 'C',
    expiry: DATE,
    tradeDateEt: DATE,
    side: 'ask',
    delta: 0.5,
    size: 100,
    price: 1.25,
    ...o,
  };
}

/** Assert the JS reducer and the SQL replica agree on all four sums. */
function expectParity(rows: readonly RawRow[]): void {
  const js = computeFlowMetrics(rows.map(toFlowTradeRow));
  const sql = sqlReplica(rows);
  expect(sql.ndNum).toBeCloseTo(js.ndNum, 9);
  expect(sql.ndDen).toBeCloseTo(js.ndDen, 9);
  expect(sql.idxPutPremium).toBeCloseTo(js.idxPutPremium, 9);
  expect(sql.totalPremium).toBeCloseTo(js.totalPremium, 9);
}

describe('flow-regime SQL ↔ JS metric parity', () => {
  it('agrees on a mixed bucket (ask/bid index puts + non-index calls)', () => {
    const rows: RawRow[] = [
      row({ ticker: 'SPY', optionType: 'P', side: 'ask', delta: -0.5 }),
      row({
        ticker: 'QQQ',
        optionType: 'P',
        side: 'bid',
        delta: -0.4,
        price: 2,
      }),
      row({
        ticker: 'SPXW',
        optionType: 'P',
        side: 'ask',
        delta: -0.6,
        size: 50,
      }),
      row({ ticker: 'NVDA', optionType: 'C', side: 'ask', delta: 0.3 }),
      row({
        ticker: 'TSLA',
        optionType: 'C',
        side: 'mid',
        delta: 0.2,
        price: 4,
      }),
    ];
    expectParity(rows);
  });

  it('excludes non-universe rows from the SUMs (but they still count in n_trades)', () => {
    const offUniverse = 'ZZZZ'; // not in the baseline universe
    expect(universe).not.toContain(offUniverse);
    const rows: RawRow[] = [
      row({ ticker: 'SPY', optionType: 'P', side: 'ask', delta: -0.5 }),
      row({
        ticker: offUniverse,
        optionType: 'P',
        side: 'ask',
        delta: -9,
        price: 99,
      }),
      row({
        ticker: offUniverse,
        optionType: 'C',
        side: 'bid',
        delta: 9,
        price: 99,
      }),
    ];
    expectParity(rows);

    // n_trades counts ALL rows; the JS reducer's population is rows.length too.
    expect(sqlReplica(rows).nTrades).toBe(3);
  });

  it('treats NULL delta as 0 contribution to both nd_num and nd_den', () => {
    const rows: RawRow[] = [
      row({ ticker: 'SPY', optionType: 'P', side: 'ask', delta: null }),
      row({ ticker: 'QQQ', optionType: 'C', side: 'bid', delta: 0.4 }),
    ];
    expectParity(rows);
  });

  it('treats NULL price as excluded from the premium SUMs', () => {
    const rows: RawRow[] = [
      row({ ticker: 'SPY', optionType: 'P', side: 'ask', price: null }),
      row({
        ticker: 'QQQ',
        optionType: 'P',
        side: 'ask',
        price: 3,
        delta: -0.5,
      }),
    ];
    expectParity(rows);

    // The null-price row contributes nothing to premium; only the QQQ row does.
    const sql = sqlReplica(rows);
    expect(sql.totalPremium).toBeCloseTo(3 * 100 * 100, 9);
    expect(sql.idxPutPremium).toBeCloseTo(3 * 100 * 100, 9);
  });

  it('only counts 0DTE index puts in idx_put_premium (non-0DTE / call / non-index excluded)', () => {
    const rows: RawRow[] = [
      // 0DTE index put — counts.
      row({
        ticker: 'SPY',
        optionType: 'P',
        side: 'ask',
        delta: -0.5,
        price: 2,
      }),
      // index call — excluded from idx_put.
      row({
        ticker: 'SPY',
        optionType: 'C',
        side: 'ask',
        delta: 0.5,
        price: 2,
      }),
      // non-0DTE index put (expiry != trade date) — excluded from idx_put.
      row({
        ticker: 'QQQ',
        optionType: 'P',
        side: 'ask',
        delta: -0.5,
        price: 2,
        expiry: '2026-06-06',
      }),
      // non-index put — excluded from idx_put (still in total_premium).
      row({
        ticker: 'NVDA',
        optionType: 'P',
        side: 'ask',
        delta: -0.5,
        price: 2,
      }),
    ];
    expectParity(rows);

    const sql = sqlReplica(rows);
    // Only the first row qualifies as a 0DTE index put.
    expect(sql.idxPutPremium).toBeCloseTo(2 * 100 * 100, 9);
    // All four (universe) rows contribute to total_premium.
    expect(sql.totalPremium).toBeCloseTo(4 * 2 * 100 * 100, 9);
  });

  it('maps side via the baseline side_sign map (ask=+1, bid=−1, else 0)', () => {
    const rows: RawRow[] = [
      row({ ticker: 'SPY', side: 'ask', delta: 0.5 }), // +0.5·size
      row({ ticker: 'SPY', side: 'bid', delta: 0.5 }), // −0.5·size
      row({ ticker: 'SPY', side: 'mid', delta: 0.5 }), // 0
      row({ ticker: 'SPY', side: 'no_side', delta: 0.5 }), // 0
      row({ ticker: 'SPY', side: 'garbage', delta: 0.5 }), // unknown → 0
    ];
    expectParity(rows);

    // Guard the concrete assertions below against a baseline regen silently
    // changing the ask/bid signs (they're derived from the committed map, but
    // the expected ndNum below assumes ask=+1, bid=−1).
    expect(sideSignMap.ask).toBe(1);
    expect(sideSignMap.bid).toBe(-1);

    const sql = sqlReplica(rows);
    // ask(+0.5·100) + bid(−0.5·100) + 0 + 0 + 0 = 0.
    expect(sql.ndNum).toBeCloseTo(0, 9);
    // |delta|·size summed over all 5 (sign-independent) = 5·0.5·100 = 250.
    expect(sql.ndDen).toBeCloseTo(250, 9);
  });

  it('returns all-zero sums for an empty window (COALESCE → 0, n_trades 0)', () => {
    const sql = sqlReplica([]);
    expect(sql).toEqual({
      ndNum: 0,
      ndDen: 0,
      idxPutPremium: 0,
      totalPremium: 0,
      nTrades: 0,
    });
    expectParity([]);
  });
});
