/**
 * Row — one strike's worth of cells in the GEX Strike Board table.
 *
 * Receives a single `StrikeScore` plus precomputed bar stats and rank-change
 * info, and renders the twelve cells (RK / change / strike / dist / Δ% /
 * CHEX / DEX / VEX / Hedge/1% / MM Γ / est.Δ / HOT%). All per-row
 * computations (color picks, tooltip selection, dealer-bar geometry) are
 * derived from props, so the component is pure and `memo`-friendly.
 *
 * The C/P (est. Δ) cell renders inline rather than via a child component
 * because its bar is centre-anchored (ticks left/right of zero) — different
 * geometry than the standard CHEX/DEX/VEX `GreekBar`, and worth keeping
 * adjacent to the cell that owns it.
 *
 * The Periscope Γ cell shows the strike's periscope_snapshots gamma
 * (UW Periscope's market-maker estimate before 2026-05-26, GEXBot's
 * taker-side gamma since). On UW-era slices it adds a ✓ / ✗ sign
 * comparison against the naive Hedge/1% (different scales, so only the
 * signs are compared). That check is UW-era logic, so GEXBot slices show
 * the value with no marker (owner decision D1 revised, 2026-10-29).
 */

import { memo } from 'react';
import { theme } from '../../../themes';
import type { StrikeScore } from '../../../utils/gex-target';
import { BAR_H, BAR_MAX_W, type BarStats } from './bars';
import { GreekBar } from './GreekBar';
import { RankArrow, type RankChangeInfo } from './RankArrow';
import { formatDeltaPct } from '../../../utils/component-formatters';
import { formatDist, formatGexBare, formatNet } from './formatters';
import {
  CHEX_TOOLTIPS,
  CP_TOOLTIPS,
  DEX_TOOLTIPS,
  VEX_TOOLTIPS,
} from './tooltips';

export interface BarStatsBundle {
  charm: BarStats;
  delta: BarStats;
  vanna: BarStats;
  cp: BarStats;
}

export interface RowProps {
  s: StrikeScore;
  displayRank: number;
  rankChange: RankChangeInfo;
  barStats: BarStatsBundle;
  isAlt: boolean;
  /**
   * Dollar gamma at this strike from periscope_snapshots, or
   * `null` when no slot exists for the strike (e.g. pre-market, or
   * strike is outside the periscope_snapshots coverage window). Scale
   * differs from `features.gexDollars` — the agreement marker compares
   * signs, not magnitudes.
   */
  mmGamma: number | null;
  /**
   * True when `mmGamma` comes from a UW Periscope (scraper-era) slice, the
   * only case where the ✓ / ✗ sign check is shown.
   */
  showSignCheck: boolean;
}

const TD_CLS = 'px-1.5 py-1.5 text-[11px] font-mono whitespace-nowrap';

export const Row = memo(function Row({
  s,
  displayRank,
  rankChange,
  barStats,
  isAlt,
  mmGamma,
  showSignCheck,
}: RowProps) {
  const { features } = s;

  // Dist color: positive = above spot (green), negative = below (red)
  const distColor = features.distFromSpot >= 0 ? theme.green : theme.red;

  // deltaPct_1m color
  const deltaPct1m = features.deltaPct_1m;
  const deltaPctColor =
    deltaPct1m === null
      ? theme.textMuted
      : deltaPct1m >= 0
        ? theme.green
        : theme.red;

  // est. Δ — net dealer delta in contracts from greek_exposure_strike.
  // Null when the daily greek exposure cron hasn't run yet (pre-market).
  const estDealerDelta = (features.callDelta ?? 0) + (features.putDelta ?? 0);
  const halfW = BAR_MAX_W / 2;
  const dealerBarW =
    Math.tanh(Math.abs(estDealerDelta) / barStats.cp.scale) * halfW;
  const dealerColor = estDealerDelta >= 0 ? theme.green : theme.red;

  // HOT% — absolute 1m delta pct (deltaPct_1m is a fraction, ×100 for display)
  const hotPct = `${(Math.abs(deltaPct1m ?? 0) * 100).toFixed(0)}%`;
  // ≥10% 1m move — Wonce's "big delta from previous update" predictive threshold.
  const isHot = Math.abs(deltaPct1m ?? 0) >= 0.1;

  const gexColor = features.gexDollars >= 0 ? theme.green : theme.red;

  // Sign comparison with the naive Hedge/1% (`features.gexDollars`), UW-era
  // slices only: on GEXBot slices the Periscope value is taker flow, not a
  // market-maker position, so no marker. Either 0 → no marker (ambiguous).
  // Null → no marker (no Periscope value to compare).
  const mmAgreement: 'agree' | 'disagree' | 'none' =
    !showSignCheck ||
    mmGamma === null ||
    mmGamma === 0 ||
    features.gexDollars === 0
      ? 'none'
      : mmGamma > 0 === features.gexDollars > 0
        ? 'agree'
        : 'disagree';
  const mmColor =
    mmGamma === null ? theme.textMuted : mmGamma >= 0 ? theme.green : theme.red;

  const rowBg = s.isTarget
    ? 'rgba(99,102,241,0.10)'
    : isAlt
      ? 'var(--color-table-alt)'
      : undefined;

  // Greek bar tooltips — pick the +/-/zero variant from the per-greek bucket.
  const charmTooltip =
    Math.abs(features.charmNet) <= barStats.charm.nearZeroThreshold
      ? CHEX_TOOLTIPS.zero
      : features.charmNet > 0
        ? CHEX_TOOLTIPS.positive
        : CHEX_TOOLTIPS.negative;

  const deltaTooltip =
    Math.abs(features.deltaNet) <= barStats.delta.nearZeroThreshold
      ? DEX_TOOLTIPS.zero
      : features.deltaNet > 0
        ? DEX_TOOLTIPS.positive
        : DEX_TOOLTIPS.negative;

  const vannaTooltip =
    Math.abs(features.vannaNet) <= barStats.vanna.nearZeroThreshold
      ? VEX_TOOLTIPS.zero
      : features.vannaNet > 0
        ? VEX_TOOLTIPS.positive
        : VEX_TOOLTIPS.negative;

  const cpTooltip =
    Math.abs(estDealerDelta) <= barStats.cp.nearZeroThreshold
      ? CP_TOOLTIPS.zero
      : estDealerDelta > 0
        ? CP_TOOLTIPS.positive
        : CP_TOOLTIPS.negative;

  return (
    <tr
      style={{ backgroundColor: rowBg }}
      aria-current={s.isTarget ? 'true' : undefined}
    >
      {/* RK */}
      <td className={TD_CLS} style={{ color: theme.textSecondary }}>
        {displayRank}
      </td>

      {/* Rank change */}
      <td className={TD_CLS} style={{ fontSize: 10 }}>
        <RankArrow info={rankChange} />
      </td>

      {/* Strike */}
      <td className={TD_CLS} style={{ color: theme.text }}>
        {s.strike}
      </td>

      {/* Dist */}
      <td className={TD_CLS} style={{ color: distColor }}>
        {formatDist(features.distFromSpot)}
      </td>

      {/* Δ% */}
      <td className={TD_CLS} style={{ color: deltaPctColor }}>
        {formatDeltaPct(features.deltaPct_1m)}
      </td>

      {/* CHEX — title on <td> so full cell triggers tooltip */}
      <td className={TD_CLS} title={charmTooltip}>
        <GreekBar
          value={features.charmNet}
          scale={barStats.charm.scale}
          nearZeroThreshold={barStats.charm.nearZeroThreshold}
        />
      </td>

      {/* DEX */}
      <td className={TD_CLS} title={deltaTooltip}>
        <GreekBar
          value={features.deltaNet}
          scale={barStats.delta.scale}
          nearZeroThreshold={barStats.delta.nearZeroThreshold}
        />
      </td>

      {/* VEX */}
      <td className={TD_CLS} title={vannaTooltip}>
        <GreekBar
          value={features.vannaNet}
          scale={barStats.vanna.scale}
          nearZeroThreshold={barStats.vanna.nearZeroThreshold}
        />
      </td>

      {/* Hedge/1% */}
      <td className={TD_CLS} style={{ color: gexColor }}>
        {formatGexBare(features.gexDollars)}
      </td>

      {/* Periscope Γ — periscope_snapshots dollar gamma, with a sign
          comparison against Hedge/1% on UW-era slices only (different
          scale, so only the signs are compared). */}
      <td className={TD_CLS} style={{ color: mmColor }}>
        {mmGamma === null ? (
          <span style={{ color: theme.textMuted }}>—</span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <span>{formatGexBare(mmGamma)}</span>
            {mmAgreement === 'agree' && (
              <span
                aria-label="Periscope gamma sign matches the naive Hedge sign"
                title="Periscope gamma sign matches the naive Hedge sign"
                style={{ color: theme.green }}
              >
                ✓
              </span>
            )}
            {mmAgreement === 'disagree' && (
              <span
                aria-label="Periscope gamma sign differs from the naive Hedge sign"
                title="Periscope gamma sign differs from the naive Hedge sign"
                style={{ color: theme.red }}
              >
                ✗
              </span>
            )}
          </span>
        )}
      </td>

      {/* est. Δ — centre-anchored bar with sign-extending fill */}
      <td className={TD_CLS} title={cpTooltip}>
        <div className="flex items-center gap-1">
          <div
            style={{
              width: BAR_MAX_W,
              height: BAR_H,
              position: 'relative',
            }}
          >
            {/* Centre tick */}
            <div
              style={{
                position: 'absolute',
                left: halfW - 0.5,
                width: 1,
                height: BAR_H,
                backgroundColor: theme.textMuted,
                opacity: 0.35,
              }}
            />
            {/* Bar extends left (negative) or right (positive) from centre */}
            <div
              style={{
                position: 'absolute',
                left: estDealerDelta >= 0 ? halfW : halfW - dealerBarW,
                width: dealerBarW,
                height: BAR_H,
                backgroundColor: dealerColor,
                borderRadius: 2,
                opacity: estDealerDelta === 0 ? 0.25 : 0.85,
              }}
            />
          </div>
          <span
            style={{ color: dealerColor }}
            className="w-10 text-right text-[10px]"
          >
            {formatNet(estDealerDelta)}
          </span>
        </div>
      </td>

      {/* HOT% */}
      <td className={TD_CLS}>
        <span
          className="rounded px-1 py-0.5 text-[10px]"
          style={{
            backgroundColor: isHot
              ? 'rgba(255,180,0,0.15)'
              : 'rgba(255,255,255,0.06)',
            color: isHot ? '#ffb300' : theme.textSecondary,
            border: isHot ? '1px solid rgba(255,180,0,0.35)' : undefined,
            fontWeight: isHot ? 700 : undefined,
          }}
        >
          {hotPct}
        </span>
      </td>
    </tr>
  );
});
