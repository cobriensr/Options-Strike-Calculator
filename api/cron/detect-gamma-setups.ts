/**
 * GET /api/cron/detect-gamma-setups
 *
 * Real-time detector for the Gamma-Node Composite tile. Runs every
 * minute during RTH (13:30-21:00 UTC, Mon-Fri) and writes fires to
 * `ws_gamma_setup_fires`. UNIQUE (fired_at, signal_type, node_strike)
 * on the table keeps this idempotent across cron-tick boundaries.
 *
 * Three trigger types (see api/_lib/gamma-detector.ts):
 *   - E1 long-call breakthrough
 *   - E5 long-put failed-reversal
 *   - PCS Monday rejection
 *
 * The cron pulls the last ~20 SPX 1-min bars, the latest periscope
 * gamma snapshot, and the day's context (open-gap, pre-day filter,
 * calendar anti-filters) in parallel. Each detector reads from that
 * snapshot — no per-bar DB chatter inside the detection loop.
 *
 * Spec: docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md
 */

import { getDb } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  computeEsBasisChange5m,
  detectE1,
  detectE5,
  detectPcsMonday,
  findNearestCeilingAbove,
  findNearestFloorBelow,
  getConfidenceTier,
  insertFire,
  loadDayContext,
  loadPositiveGammaNodes,
  loadRecentBars,
  type DetectorFire,
} from '../_lib/gamma-detector.js';

export default withCronInstrumentation(
  'detect-gamma-setups',
  async (ctx): Promise<CronResult> => {
    const sql = getDb();
    const now = new Date();

    // Day context first — DOW and anti-filter flags gate every detector.
    const dayCtx = await loadDayContext(sql, now);

    if (dayCtx.dow_label == null) {
      // Weekend — cronGuard already short-circuits via isMarketHours,
      // but defend in depth: skip work on Sat/Sun even if forced.
      return {
        status: 'success',
        rows: 0,
        metadata: { reason: 'weekend' },
      };
    }

    // Parallel: candles, periscope nodes, ES basis. Each is independent.
    // computeEsBasisChange5m defaults to NOW() — the live cron always wants
    // the most recent window. The backfill script passes a referenceTime.
    const [bars, nodes, esBasis] = await Promise.all([
      loadRecentBars(sql, dayCtx.today, 20),
      loadPositiveGammaNodes(sql, dayCtx.today),
      computeEsBasisChange5m(sql),
    ]);

    if (bars.length === 0 || nodes.length === 0) {
      // Nothing to evaluate — either it's pre-open or periscope is stale.
      return {
        status: 'success',
        rows: 0,
        metadata: {
          reason: 'no_data',
          bars: bars.length,
          nodes: nodes.length,
        },
      };
    }

    const currentBar = bars.at(-1);
    if (currentBar == null) {
      return {
        status: 'success',
        rows: 0,
        metadata: { reason: 'no_current_bar' },
      };
    }
    const tier = getConfidenceTier(
      dayCtx.dow_label,
      dayCtx.pre_day_filter_fires,
    );
    const fires: DetectorFire[] = [];

    // --- E1: long-call breakthrough ----------------------------------
    const e1Hit = detectE1(bars, nodes);
    if (e1Hit != null) {
      fires.push({
        fired_at: e1Hit.holdBar.timestamp,
        signal_type: 'e1_long_call',
        dow_label: dayCtx.dow_label,
        confidence_tier: tier,
        spot_at_fire: currentBar.close,
        node_strike: e1Hit.node.strike,
        node_gex: e1Hit.node.value,
        bar_open: e1Hit.breakBar.open,
        bar_high: e1Hit.breakBar.high,
        bar_low: e1Hit.breakBar.low,
        bar_close: e1Hit.breakBar.close,
        bar_range: e1Hit.breakBar.high - e1Hit.breakBar.low,
        es_basis_change_5m: esBasis,
        prior_5d_ret: dayCtx.prior_5d_ret,
        prior_iv_rank: dayCtx.prior_iv_rank,
        pre_day_filter_fires: dayCtx.pre_day_filter_fires,
        open_gap_pct: dayCtx.open_gap_pct,
        is_fomc_day: dayCtx.is_fomc_day,
        is_dom_1_5: dayCtx.is_dom_1_5,
        is_dom_16_20: dayCtx.is_dom_16_20,
      });
    }

    // --- E5: long-put failed-reversal --------------------------------
    const e5Hit = detectE5(bars, nodes);
    if (e5Hit != null) {
      fires.push({
        fired_at: e5Hit.breakBar.timestamp,
        signal_type: 'e5_long_put',
        dow_label: dayCtx.dow_label,
        confidence_tier: tier,
        spot_at_fire: currentBar.close,
        node_strike: e5Hit.node.strike,
        node_gex: e5Hit.node.value,
        bar_open: e5Hit.breakBar.open,
        bar_high: e5Hit.breakBar.high,
        bar_low: e5Hit.breakBar.low,
        bar_close: e5Hit.breakBar.close,
        bar_range: e5Hit.breakBar.high - e5Hit.breakBar.low,
        es_basis_change_5m: esBasis,
        prior_5d_ret: dayCtx.prior_5d_ret,
        prior_iv_rank: dayCtx.prior_iv_rank,
        pre_day_filter_fires: dayCtx.pre_day_filter_fires,
        open_gap_pct: dayCtx.open_gap_pct,
        is_fomc_day: dayCtx.is_fomc_day,
        is_dom_1_5: dayCtx.is_dom_1_5,
        is_dom_16_20: dayCtx.is_dom_16_20,
      });
    }

    // --- PCS: Monday rejection ---------------------------------------
    const pcsHit = detectPcsMonday(bars, nodes, dayCtx, esBasis);
    if (pcsHit != null) {
      fires.push({
        fired_at: pcsHit.wickBar.timestamp,
        signal_type: 'pcs_monday',
        dow_label: dayCtx.dow_label,
        confidence_tier: tier,
        spot_at_fire: currentBar.close,
        node_strike: pcsHit.node.strike,
        node_gex: pcsHit.node.value,
        bar_open: pcsHit.wickBar.open,
        bar_high: pcsHit.wickBar.high,
        bar_low: pcsHit.wickBar.low,
        bar_close: pcsHit.wickBar.close,
        bar_range: pcsHit.wickBar.high - pcsHit.wickBar.low,
        es_basis_change_5m: esBasis,
        prior_5d_ret: dayCtx.prior_5d_ret,
        prior_iv_rank: dayCtx.prior_iv_rank,
        pre_day_filter_fires: dayCtx.pre_day_filter_fires,
        open_gap_pct: dayCtx.open_gap_pct,
        is_fomc_day: dayCtx.is_fomc_day,
        is_dom_1_5: dayCtx.is_dom_1_5,
        is_dom_16_20: dayCtx.is_dom_16_20,
      });
    }

    let inserted = 0;
    for (const fire of fires) {
      if (await insertFire(sql, fire)) inserted += 1;
    }

    // Decorate the response with the nearest +γ floor/ceiling so the
    // active-day endpoint can display "next +γ floor below" / "next +γ
    // ceiling above" hints in the tile without re-querying.
    const nearestCeiling = findNearestCeilingAbove(nodes, currentBar.close);
    const nearestFloor = findNearestFloorBelow(nodes, currentBar.close);

    ctx.logger.info(
      {
        bars: bars.length,
        nodes: nodes.length,
        candidate_fires: fires.length,
        inserted,
        dow: dayCtx.dow_label,
        tier,
      },
      'detect-gamma-setups: scan complete',
    );

    return {
      status: 'success',
      rows: inserted,
      metadata: {
        dow: dayCtx.dow_label,
        confidence_tier: tier,
        pre_day_filter_fires: dayCtx.pre_day_filter_fires,
        candidates: fires.length,
        bars_loaded: bars.length,
        nodes_loaded: nodes.length,
        nearest_ceiling: nearestCeiling?.strike ?? null,
        nearest_floor: nearestFloor?.strike ?? null,
      },
    };
  },
  // Reads DB only — no UW API call from this cron.
  { requireApiKey: false },
);
