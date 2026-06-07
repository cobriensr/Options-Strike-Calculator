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

import { describe, expect, it, vi } from 'vitest';
import { loadFlowRegimeBaseline } from '../_lib/flow-regime-baseline-live.js';
import { FLOW_REGIME_BASELINE } from '../_lib/flow-regime.js';

const MIN_DAYS = FLOW_REGIME_BASELINE.min_days_per_slot; // 15
const N_PCTL = FLOW_REGIME_BASELINE.percentiles.length; // 9

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
        nd_breakpoints: ndBreaks.map((n) => String(n)),
        idx_breakpoints: liveBreaks(0.03).map((n) => String(n)),
      },
    ]);

    const { baseline, liveSlots } = await loadFlowRegimeBaseline(sql);

    expect(liveSlots.has(2)).toBe(true);
    const slot2 = baseline.slots.find((s) => s.slot === 2)!;
    slot2.nd_tilt_breakpoints.forEach((v, i) =>
      expect(v).toBeCloseTo(ndBreaks[i]!, 9),
    );
  });

  it('falls back when one metric is live but the other lacks depth', async () => {
    // nd has ≥15 days but idx is below threshold: the live slot uses the live
    // nd breakpoints and keeps the JSON idx breakpoints.
    const jsonSlot4 = FLOW_REGIME_BASELINE.slots.find((s) => s.slot === 4)!;
    const ndBreaks = liveBreaks(-0.22);
    const sql = fakeSql([
      {
        slot: 4,
        n_days_nd: MIN_DAYS + 3,
        n_days_idx: MIN_DAYS - 2,
        nd_breakpoints: ndBreaks,
        idx_breakpoints: liveBreaks(0.04),
      },
    ]);

    const { baseline, liveSlots } = await loadFlowRegimeBaseline(sql);

    expect(liveSlots.has(4)).toBe(true);
    const slot4 = baseline.slots.find((s) => s.slot === 4)!;
    expect(slot4.nd_tilt_breakpoints).toEqual(ndBreaks);
    expect(slot4.idx0dte_put_share_breakpoints).toEqual(
      jsonSlot4.idx0dte_put_share_breakpoints,
    );
  });
});
