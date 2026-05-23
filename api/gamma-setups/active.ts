/**
 * GET /api/gamma-setups/active
 *
 * Returns today's gamma-node composite-detector fires plus the day's
 * context (DOW + confidence tier + filter status + anti-filter warnings)
 * and the nearest +γ floor/ceiling from the latest periscope snapshot.
 *
 * Owner-or-guest endpoint — the underlying data (SPX candles, periscope
 * snapshots) is already public for guests via other tiles, so this read
 * tile follows the same access policy.
 *
 * Polled by the frontend `useGammaSetups` hook every ~30s during RTH.
 * No query params; the response carries everything the tile needs to
 * render from a single fetch.
 *
 * Spec: docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import {
  findNearestCeilingAbove,
  findNearestFloorBelow,
  getConfidenceTier,
  getDowLabel,
  loadDayContext,
  loadPositiveGammaNodes,
  loadRecentBars,
  type ConfidenceTier,
  type DowLabel,
  type SignalType,
} from '../_lib/gamma-detector.js';
import { getETDateStr } from '../../src/utils/timezone.js';

/** Neon NUMERIC columns come back as strings to preserve precision;
 *  the response shaper coerces them to JS numbers at the boundary. */
type DbNumeric = string | number;
/** Same coercion shape but for nullable NUMERIC columns. */
type DbNullableNumeric = DbNumeric | null;

interface FireRow {
  id: DbNumeric;
  fired_at: string | Date;
  signal_type: SignalType;
  dow_label: DowLabel;
  confidence_tier: ConfidenceTier;
  spot_at_fire: DbNumeric;
  node_strike: number;
  node_gex: DbNumeric;
  bar_open: DbNumeric;
  bar_high: DbNumeric;
  bar_low: DbNumeric;
  bar_close: DbNumeric;
  bar_range: DbNumeric;
  es_basis_change_5m: DbNullableNumeric;
  ret_15m: DbNullableNumeric;
  ret_30m: DbNullableNumeric;
  ret_60m: DbNullableNumeric;
  ret_eod: DbNullableNumeric;
  trade_taken: boolean;
  trade_pnl_dollars: DbNullableNumeric;
}

export interface GammaSetupFire {
  id: number;
  fired_at: string;
  signal_type: SignalType;
  dow_label: DowLabel;
  confidence_tier: ConfidenceTier;
  spot_at_fire: number;
  node_strike: number;
  node_gex: number;
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_range: number;
  es_basis_change_5m: number | null;
  ret_15m: number | null;
  ret_30m: number | null;
  ret_60m: number | null;
  ret_eod: number | null;
  trade_taken: boolean;
  trade_pnl_dollars: number | null;
}

export interface GammaSetupsActiveResponse {
  today: string;
  dow_label: DowLabel | null;
  confidence_tier: ConfidenceTier | null;
  pre_day_filter_fires: boolean;
  prior_5d_ret: number | null;
  prior_iv_rank: number | null;
  open_gap_pct: number;
  anti_filters: {
    is_fomc_day: boolean;
    is_dom_1_5: boolean;
    is_dom_16_20: boolean;
  };
  nearest_floor: { strike: number; gex: number } | null;
  nearest_ceiling: { strike: number; gex: number } | null;
  fires: GammaSetupFire[];
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number.parseFloat(v);
  return 0;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  return num(v);
}

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

function shapeFire(r: FireRow): GammaSetupFire {
  return {
    id: num(r.id),
    fired_at: iso(r.fired_at),
    signal_type: r.signal_type,
    dow_label: r.dow_label,
    confidence_tier: r.confidence_tier,
    spot_at_fire: num(r.spot_at_fire),
    node_strike: r.node_strike,
    node_gex: num(r.node_gex),
    bar_open: num(r.bar_open),
    bar_high: num(r.bar_high),
    bar_low: num(r.bar_low),
    bar_close: num(r.bar_close),
    bar_range: num(r.bar_range),
    es_basis_change_5m: numOrNull(r.es_basis_change_5m),
    ret_15m: numOrNull(r.ret_15m),
    ret_30m: numOrNull(r.ret_30m),
    ret_60m: numOrNull(r.ret_60m),
    ret_eod: numOrNull(r.ret_eod),
    trade_taken: r.trade_taken,
    trade_pnl_dollars: numOrNull(r.trade_pnl_dollars),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/gamma-setups/active');
    const done = metrics.request('/api/gamma-setups/active');

    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        res.status(405).json({ error: 'GET only' });
        return;
      }
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const sql = getDb();
      const now = new Date();
      const today = getETDateStr(now);
      const dowLabel = getDowLabel(now);

      // Day context + nodes + fires in parallel — independent reads.
      const [dayCtx, nodes, fireRows] = await Promise.all([
        loadDayContext(sql, now),
        loadPositiveGammaNodes(sql, today),
        withDbRetry(
          () => sql`
            SELECT
              id, fired_at, signal_type, dow_label, confidence_tier,
              spot_at_fire, node_strike, node_gex,
              bar_open, bar_high, bar_low, bar_close, bar_range,
              es_basis_change_5m,
              ret_15m, ret_30m, ret_60m, ret_eod,
              trade_taken, trade_pnl_dollars
            FROM ws_gamma_setup_fires
            WHERE fired_at::date = (
              (NOW() AT TIME ZONE 'America/New_York')::date
            )
            ORDER BY fired_at ASC
          `,
          2,
          10_000,
        ),
      ]);
      const rawFires = fireRows as FireRow[];

      // Spot from the latest 1-min bar is more accurate than the last
      // fire's spot, since spot moves continuously between fires.
      const recentBars = await loadRecentBars(sql, today, 1);
      const spotNow = recentBars.at(-1)?.close ?? null;

      const nearestFloor =
        spotNow != null ? findNearestFloorBelow(nodes, spotNow) : null;
      const nearestCeiling =
        spotNow != null ? findNearestCeilingAbove(nodes, spotNow) : null;

      const confidenceTier =
        dowLabel != null
          ? getConfidenceTier(dowLabel, dayCtx.pre_day_filter_fires)
          : null;

      const response: GammaSetupsActiveResponse = {
        today,
        dow_label: dowLabel,
        confidence_tier: confidenceTier,
        pre_day_filter_fires: dayCtx.pre_day_filter_fires,
        prior_5d_ret: dayCtx.prior_5d_ret,
        prior_iv_rank: dayCtx.prior_iv_rank,
        open_gap_pct: dayCtx.open_gap_pct,
        anti_filters: {
          is_fomc_day: dayCtx.is_fomc_day,
          is_dom_1_5: dayCtx.is_dom_1_5,
          is_dom_16_20: dayCtx.is_dom_16_20,
        },
        nearest_floor:
          nearestFloor != null
            ? { strike: nearestFloor.strike, gex: nearestFloor.value }
            : null,
        nearest_ceiling:
          nearestCeiling != null
            ? { strike: nearestCeiling.strike, gex: nearestCeiling.value }
            : null,
        fires: rawFires.map(shapeFire),
      };

      done({ status: 200 });
      res.status(200).json(response);
    } catch (err) {
      Sentry.captureException(err);
      done({ status: 500 });
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
