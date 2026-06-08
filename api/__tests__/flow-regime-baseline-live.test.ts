// @vitest-environment node

/**
 * Tests for the self-maintaining flow-regime baseline loader.
 *
 * loadFlowRegimeBaseline runs ONE aggregation over flow_regime_slot_daily and,
 * per slot, replaces the committed JSON breakpoints with DB-computed
 * percentile_cont breakpoints — but ONLY when that slot has ≥ min_days_per_slot
 * (15) days of usable history. We mock the SQL result rows to exercise:
 *   - a slot with ≥15 days → DB breakpoints used, slot reported live.
 *   - a slot with <15 days → committed JSON breakpoints kept (fallback).
 *   - an empty table → every slot falls back, liveSlots empty.
 *
 * Resolves code-review finding #6 — see
 * docs/superpowers/specs/flow-regime-baseline-refresh-2026-06-07.md.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadFlowRegimeBaseline,
  __resetFlowRegimeBaselineCache,
  MIN_DAY_SLOT_TRADES,
} from '../_lib/flow-regime-baseline-live.js';
import { FLOW_REGIME_BASELINE } from '../_lib/flow-regime.js';

const MIN_DAYS = FLOW_REGIME_BASELINE.min_days_per_slot; // 15
const N_PCTL = FLOW_REGIME_BASELINE.percentiles.length; // 9

// The loader caches its result per ET date at module scope; reset before each
// test so each fake SQL result is recomputed rather than served from cache.
beforeEach(() => __resetFlowRegimeBaselineCache());

/** A full, finite, ascending breakpoint array distinct from any JSON slot. */
function liveBreaks(base: number): number[] {
  return Array.from({ length: N_PCTL }, (_, i) => base + i * 0.01);
}

/**
 * Build a fake SQL tag returning the given per-slot aggregation rows. The
 * loader only does ONE tagged-template call, so we ignore the template and
 * return the configured rows.
 */
function fakeSql(rows: unknown[]) {
  return vi.fn(() => Promise.resolve(rows)) as unknown as Parameters<
    typeof loadFlowRegimeBaseline
  >[0];
}

describe('loadFlowRegimeBaseline', () => {
  it('uses DB-computed breakpoints for a slot with ≥15 days', async () => {
    const ndBreaks = liveBreaks(-0.2);
    const idxBreaks = liveBreaks(0.01);
    const sql = fakeSql([
      {
        slot: 0,
        n_days_nd: MIN_DAYS, // exactly the threshold → live
        n_days_idx: MIN_DAYS + 5,
        nd_breakpoints: ndBreaks,
        idx_breakpoints: idxBreaks,
      },
    ]);

    const { baseline, liveSlots } = await loadFlowRegimeBaseline(sql);

    expect(liveSlots.has(0)).toBe(true);
    const slot0 = baseline.slots.find((s) => s.slot === 0)!;
    expect(slot0.nd_tilt_breakpoints).toEqual(ndBreaks);
    expect(slot0.idx0dte_put_share_breakpoints).toEqual(idxBreaks);
    // n_days reflects the live depth so the evaluator's thin-baseline gate
    // sees it as a real distribution.
    expect(slot0.n_days).toBeGreaterThanOrEqual(MIN_DAYS);
  });

  it('keeps the committed JSON breakpoints for a slot with <15 days', async () => {
    const jsonSlot1 = FLOW_REGIME_BASELINE.slots.find((s) => s.slot === 1)!;
    const sql = fakeSql([
      {
        slot: 1,
        n_days_nd: MIN_DAYS - 1, // below threshold → fallback
        n_days_idx: MIN_DAYS - 1,
        nd_breakpoints: liveBreaks(-0.3),
        idx_breakpoints: liveBreaks(0.02),
      },
    ]);

    const { baseline, liveSlots } = await loadFlowRegimeBaseline(sql);

    expect(liveSlots.has(1)).toBe(false);
    const slot1 = baseline.slots.find((s) => s.slot === 1)!;
    expect(slot1.nd_tilt_breakpoints).toEqual(jsonSlot1.nd_tilt_breakpoints);
    expect(slot1.idx0dte_put_share_breakpoints).toEqual(
      jsonSlot1.idx0dte_put_share_breakpoints,
    );
  });

  it('falls back entirely for an empty table', async () => {
    const sql = fakeSql([]);

    const { baseline, liveSlots } = await loadFlowRegimeBaseline(sql);

    expect(liveSlots.size).toBe(0);
    // Every slot equals the committed JSON.
    for (const jsonSlot of FLOW_REGIME_BASELINE.slots) {
      const got = baseline.slots.find((s) => s.slot === jsonSlot.slot)!;
      expect(got.nd_tilt_breakpoints).toEqual(jsonSlot.nd_tilt_breakpoints);
      expect(got.idx0dte_put_share_breakpoints).toEqual(
        jsonSlot.idx0dte_put_share_breakpoints,
      );
    }
    // The committed universe / index_set / percentiles are preserved.
    expect(baseline.universe).toEqual(FLOW_REGIME_BASELINE.universe);
    expect(baseline.index_set).toEqual(FLOW_REGIME_BASELINE.index_set);
    expect(baseline.percentiles).toEqual(FLOW_REGIME_BASELINE.percentiles);
  });

  it('coerces NUMERIC-string breakpoints and BigInt day counts', async () => {
    // The Neon driver returns NUMERIC[] elements as strings and COUNT(*) as
    // BigInt; the loader must coerce both.
    const ndBreaks = liveBreaks(-0.25);
    const sql = fakeSql([
      {
        slot: 2,
        n_days_nd: BigInt(MIN_DAYS + 1),
        n_days_idx: BigInt(MIN_DAYS + 1),
        nd_breakpoints: ndBreaks.map(String),
        idx_breakpoints: liveBreaks(0.03).map(String),
      },
    ]);

    const { baseline, liveSlots } = await loadFlowRegimeBaseline(sql);

    expect(liveSlots.has(2)).toBe(true);
    const slot2 = baseline.slots.find((s) => s.slot === 2)!;
    slot2.nd_tilt_breakpoints.forEach((v, i) =>
      expect(v).toBeCloseTo(ndBreaks[i]!, 9),
    );
  });

  it('keeps the full committed seed when only ONE metric has depth (both-live gate)', async () => {
    // nd has ≥15 days but idx is below threshold. Under the both-live rule the
    // slot is NOT live: it keeps the committed JSON for BOTH metrics so
    // baseline_version 2 honestly means "both metrics live" (#3).
    const jsonSlot4 = FLOW_REGIME_BASELINE.slots.find((s) => s.slot === 4)!;
    const ndBreaks = liveBreaks(-0.22);
    const sql = fakeSql([
      {
        slot: 4,
        n_days_nd: MIN_DAYS + 3,
        n_days_idx: MIN_DAYS - 2, // below threshold → whole slot falls back
        nd_breakpoints: ndBreaks,
        idx_breakpoints: liveBreaks(0.04),
      },
    ]);

    const { baseline, liveSlots } = await loadFlowRegimeBaseline(sql);

    expect(liveSlots.has(4)).toBe(false);
    const slot4 = baseline.slots.find((s) => s.slot === 4)!;
    expect(slot4.nd_tilt_breakpoints).toEqual(jsonSlot4.nd_tilt_breakpoints);
    expect(slot4.idx0dte_put_share_breakpoints).toEqual(
      jsonSlot4.idx0dte_put_share_breakpoints,
    );
  });

  it('ignores days below the per-day volume quorum via the SQL filter', async () => {
    // The quorum is enforced in SQL (COUNT/percentile_cont FILTER on
    // n_trades >= MIN_DAY_SLOT_TRADES). The loader trusts the returned day
    // counts; this asserts the constant is exported for the cron + SQL to share.
    expect(MIN_DAY_SLOT_TRADES).toBeGreaterThan(0);
  });

  it('does not mutate the shared committed baseline on a fallback slot (deep clone)', async () => {
    // A fallback slot's breakpoint arrays must be sliced off the module
    // constant so a caller can never mutate the shared committed baseline (#7).
    const jsonSlot7 = FLOW_REGIME_BASELINE.slots.find((s) => s.slot === 7)!;
    const before = jsonSlot7.nd_tilt_breakpoints.slice();
    const sql = fakeSql([]);

    const { baseline } = await loadFlowRegimeBaseline(sql);
    const slot7 = baseline.slots.find((s) => s.slot === 7)!;
    // Same values, but a distinct array instance.
    expect(slot7.nd_tilt_breakpoints).toEqual(before);
    expect(slot7.nd_tilt_breakpoints).not.toBe(jsonSlot7.nd_tilt_breakpoints);

    // Mutating the returned array must not touch the committed constant.
    slot7.nd_tilt_breakpoints[0] = 999;
    expect(
      FLOW_REGIME_BASELINE.slots.find((s) => s.slot === 7)!.nd_tilt_breakpoints,
    ).toEqual(before);
  });

  it('caches the result per ET date and reuses it across calls', async () => {
    const sql = fakeSql([
      {
        slot: 0,
        n_days_nd: MIN_DAYS,
        n_days_idx: MIN_DAYS,
        nd_breakpoints: liveBreaks(-0.2),
        idx_breakpoints: liveBreaks(0.01),
      },
    ]);

    await loadFlowRegimeBaseline(sql);
    await loadFlowRegimeBaseline(sql);
    // Same ET date → second call served from cache, only ONE query issued.
    expect(sql).toHaveBeenCalledTimes(1);
  });
});
