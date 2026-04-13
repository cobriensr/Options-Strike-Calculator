/**
 * StrikeBox — Panel 5: dense sofbot-style leaderboard with greek bars.
 *
 * Shows the top 5 strikes by GEX $ (largest |gexDollars|) with rank,
 * rank-change arrow, strike price, distance from spot, 1m delta%,
 * CHEX/DEX/VEX greek bars, GEX $, est. Δ, and HOT% badge.
 *
 * Rank-change tracking: a useRef holds the previous snapshot's rank map;
 * a useState holds the computed RankChangeInfo so arrows persist until the
 * next data update without triggering a reset re-render.
 *
 * Greek bar sizing uses tanh(|value| / scale) where scale = median
 * abs(value) across the displayed 5-strike set, recomputed on every render.
 * Near-zero threshold = 5th percentile of abs(value); below it the bar
 * is rendered in muted gray.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SectionBox, ScrollHint } from '../ui';
import { theme } from '../../themes';
import type { StrikeScore } from '../../utils/gex-target';

// ── Tooltip text (Appendix H — exact wording) ─────────────────────────

const CHEX_TOOLTIPS = {
  positive:
    'Positive Charm \u00B7 selling pressure into expiration\nDealers at this strike need to sell the underlying as time passes to stay hedged. This creates passive downward pressure as 0DTE approaches expiry, even without a change in the underlying price.',
  negative:
    'Negative Charm \u00B7 buying pressure into expiration\nDealers at this strike need to buy the underlying as time passes to stay hedged. This creates passive upward pressure as 0DTE approaches expiry \u2014 often the biggest tailwind for pins in the 2pm\u2013close window.',
  zero: 'Charm near zero\nNo meaningful time-decay pressure from dealer hedging at this strike. The magnet isn\u2019t being reinforced or dismantled by the passage of time alone.',
};

const DEX_TOOLTIPS = {
  positive:
    'Positive DEX \u00B7 resistance / supply overhead\nDealers are net long delta at this strike \u2014 typically from customers buying puts. They\u2019ve already shorted the underlying as a hedge. As price approaches this strike, those short hedges lean on supply and create resistance.\nUnlike charm and vanna, DEX doesn\u2019t generate new flow \u2014 it tells you where the hedges already live. The flow shows up when spot, vol, or time moves those hedges around.',
  negative:
    'Negative DEX \u00B7 support / demand underneath\nDealers are net short delta at this strike \u2014 often from customers selling calls or from calls dealers are short. They\u2019re already long the underlying as a hedge. As price drops toward this level, those long hedges anchor the tape and create support.\nDEX doesn\u2019t generate new flow \u2014 it tells you where the hedges already live.',
  zero: 'DEX near zero\nNo concentrated dealer directional exposure at this strike. It\u2019s unlikely to behave as support or resistance based on hedge positioning alone.',
};

const VEX_TOOLTIPS = {
  positive:
    'Positive VEX \u00B7 selling pressure on vol expansion\nA rise in implied volatility forces dealers at this strike to sell the underlying to stay hedged. When VIX expands \u2014 headlines, support cracks, fear bids \u2014 dealers mechanically hit bids, amplifying selloffs. Part of why vol spikes and price drops reinforce each other on the way down.',
  negative:
    'Negative VEX \u00B7 buying pressure on vol crush\nA drop in implied volatility forces dealers at this strike to buy the underlying to stay hedged. This is the classic \u2018vol crush rally\u2019 \u2014 VIX falls, dealers lift offers mechanically, price drifts higher with no catalyst. Strongest after fear spikes unwind (post-FOMC, post-CPI, Monday-morning weekend-premium decay).',
  zero: 'VEX near zero\nThis strike won\u2019t generate meaningful dealer flow from vol changes. Less interesting around VIX moves, OPEX, or vol-crush events.',
};

const CP_TOOLTIPS = {
  positive:
    'Net long gamma \u00B7 dealer long delta (support zone)\nNet GEX is positive here \u2014 dealers are net long gamma, meaning they buy dips and sell rips to stay delta-neutral. That mechanical two-way flow acts as a gravitational anchor. Expect price to be drawn toward this strike and find support on a test from above.\nFormula: net GEX$ \u00F7 (spot \u00D7 100) \u2248 dealer delta in contracts.',
  negative:
    'Net short gamma \u00B7 dealer short delta (resistance zone)\nNet GEX is negative here \u2014 dealers are net short gamma, meaning they sell into strength and buy into weakness in the same direction as price. This amplifies moves rather than dampening them. Price through this level tends to accelerate; it\u2019s a zone of fuel not a floor.\nFormula: net GEX$ \u00F7 (spot \u00D7 100) \u2248 dealer delta in contracts.',
  zero: 'Net GEX near zero\nDealer gamma exposure is roughly balanced at this strike. No strong mechanical hedging pull in either direction \u2014 less likely to act as a magnet or accelerant.',
};

// ── Formatters ────────────────────────────────────────────────────────

function formatGex(v: number): string {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function formatDeltaPct(v: number | null): string {
  if (v === null) return '\u2014';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function formatDist(dist: number): string {
  const sign = dist >= 0 ? '+' : '';
  return `${sign}${dist.toFixed(0)}p`;
}

/** Compact signed label for net values — two decimal places when fractional. */
function formatNet(v: number): string {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '−';
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${Math.round(abs / 1e3)}K`;
  if (abs >= 0.5) return `${sign}${Math.round(abs)}`;
  return `${sign}${abs.toFixed(2)}`;
}

// ── Greek bar stats ───────────────────────────────────────────────────

/**
 * Compute per-greek bar sizing parameters from the leaderboard.
 * Returns { scale, nearZeroThreshold } for a single greek's values.
 */
function computeBarStats(values: number[]): {
  scale: number;
  nearZeroThreshold: number;
} {
  if (values.length === 0) return { scale: 1, nearZeroThreshold: 1e-6 };

  const absVals = values.map(Math.abs).sort((a, b) => a - b);
  const mid = Math.floor(absVals.length / 2);
  const scale =
    absVals.length % 2 === 1
      ? (absVals[mid] ?? 0)
      : ((absVals[mid - 1] ?? 0) + (absVals[mid] ?? 0)) / 2;

  const p5Idx = Math.floor(absVals.length * 0.05);
  const nearZeroThreshold = absVals[p5Idx] ?? 1e-6;

  return {
    scale: scale || 1,
    nearZeroThreshold: nearZeroThreshold || 1e-6,
  };
}

// ── Greek bar ─────────────────────────────────────────────────────────

const BAR_MAX_W = 40;
const BAR_H = 6;

interface GreekBarProps {
  value: number;
  scale: number;
  nearZeroThreshold: number;
}

const GreekBar = memo(function GreekBar({
  value,
  scale,
  nearZeroThreshold,
}: GreekBarProps) {
  const abs = Math.abs(value);
  const isNearZero = abs <= nearZeroThreshold;
  const width = Math.tanh(abs / scale) * BAR_MAX_W;

  let barColor: string;
  if (isNearZero) {
    barColor = theme.textMuted;
  } else if (value > 0) {
    barColor = theme.green;
  } else {
    barColor = theme.red;
  }

  return (
    <div style={{ width: BAR_MAX_W, height: BAR_H, position: 'relative' }}>
      <div
        style={{
          width,
          height: BAR_H,
          backgroundColor: barColor,
          borderRadius: 2,
          opacity: isNearZero ? 0.4 : 0.85,
        }}
      />
    </div>
  );
});

// ── Rank change arrow ─────────────────────────────────────────────────

interface RankChangeInfo {
  type: 'new' | 'up' | 'down' | 'same';
  /** Positions improved (positive) or worsened (negative). Zero for same/new. */
  delta: number;
}

function RankArrow({ info }: Readonly<{ info: RankChangeInfo }>) {
  if (info.type === 'new')
    return (
      <span
        style={{ color: '#7c7cff', fontSize: 9, fontWeight: 700 }}
        aria-label="New entry"
      >
        NEW
      </span>
    );
  if (info.type === 'up')
    return (
      <span
        style={{ color: theme.green }}
        aria-label={`Rank improved by ${info.delta}`}
      >
        ↑{info.delta}
      </span>
    );
  if (info.type === 'down')
    return (
      <span
        style={{ color: theme.red }}
        aria-label={`Rank worsened by ${Math.abs(info.delta)}`}
      >
        ↓{Math.abs(info.delta)}
      </span>
    );
  return (
    <span style={{ color: theme.textMuted }} aria-label="Rank unchanged">
      &mdash;
    </span>
  );
}

// ── StrikeBox ─────────────────────────────────────────────────────────

export interface StrikeBoxProps {
  leaderboard: StrikeScore[];
}

export const StrikeBox = memo(function StrikeBox({
  leaderboard,
}: StrikeBoxProps) {
  // The parent (GexTarget/index.tsx) pre-sorts the leaderboard by |gexDollars|
  // and slices to 5 before passing it in. Use it directly — no re-sort needed.
  const top5 = leaderboard;

  // Track previous ranks in a ref so arrows persist until the NEXT data
  // update. The old useState approach caused arrows to flash once and
  // immediately reset to "same" because setPrevRanks triggered a second
  // render that overwrote the comparison before the user could see it.
  // A ref updates silently (no re-render) so the computed rankChanges
  // state is stable until top5 changes again.
  const prevRanksRef = useRef<Map<number, number>>(new Map());
  const [rankChanges, setRankChanges] = useState<Map<number, RankChangeInfo>>(
    () => new Map(),
  );

  useEffect(() => {
    const prev = prevRanksRef.current;
    const result = new Map<number, RankChangeInfo>();
    top5.forEach((s, idx) => {
      const currentRank = idx + 1;
      const prevRank = prev.get(s.strike);
      if (prevRank === undefined) {
        result.set(s.strike, { type: 'new', delta: 0 });
      } else {
        const delta = prevRank - currentRank; // positive = moved up
        result.set(s.strike, {
          type: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same',
          delta,
        });
      }
    });
    setRankChanges(result);
    const m = new Map<number, number>();
    top5.forEach((s, idx) => m.set(s.strike, idx + 1));
    prevRanksRef.current = m;
  }, [top5]);

  // Compute per-greek bar stats once per render (scoped to the displayed top5)
  const barStats = useMemo(() => {
    const charmVals = top5.map((s) => s.features.charmNet);
    const deltaVals = top5.map((s) => s.features.deltaNet);
    const vannaVals = top5.map((s) => s.features.vannaNet);
    // Net dealer delta in contracts from greek_exposure_strike (call_delta + put_delta).
    // Positive = dealers net long delta (support); negative = net short delta (resistance).
    // Falls back to 0 when the JOIN produced no greek exposure row (early session, no data).
    const cpVals = top5.map(
      (s) => (s.features.callDelta ?? 0) + (s.features.putDelta ?? 0),
    );
    return {
      charm: computeBarStats(charmVals),
      delta: computeBarStats(deltaVals),
      vanna: computeBarStats(vannaVals),
      cp: computeBarStats(cpVals),
    };
  }, [top5]);

  // Header cell style
  const thCls =
    'px-1.5 py-1 text-[10px] uppercase tracking-wide font-mono text-left whitespace-nowrap';
  const tdCls = 'px-1.5 py-1.5 text-[11px] font-mono whitespace-nowrap';

  return (
    <SectionBox label="GEX STRIKE BOARD">
      {top5.length === 0 ? (
        <p className="font-mono text-[11px]" style={{ color: theme.textMuted }}>
          No data
        </p>
      ) : (
        <ScrollHint>
          <table
            role="table"
            className="w-full border-collapse"
            aria-label="GEX Strike Leaderboard"
          >
            <thead>
              <tr style={{ color: theme.textMuted }}>
                <th className={thCls} scope="col">
                  RK
                </th>
                <th className={thCls} scope="col" aria-label="Rank change">
                  &#8597;
                </th>
                <th className={thCls} scope="col">
                  Strike
                </th>
                <th className={thCls} scope="col">
                  Dist
                </th>
                <th className={thCls} scope="col">
                  &#916;%
                </th>
                <th className={thCls} scope="col" title="Charm exposure">
                  CHEX
                </th>
                <th className={thCls} scope="col" title="Delta exposure">
                  DEX
                </th>
                <th className={thCls} scope="col" title="Vanna exposure">
                  VEX
                </th>
                <th className={thCls} scope="col">
                  GEX&nbsp;$
                </th>
                <th
                  className={thCls}
                  scope="col"
                  title="Net dealer delta in contracts (Σ call delta + Σ put delta from greek_exposure_strike). Positive = dealers net long delta (support zone); negative = net short delta (resistance zone)."
                >
                  est.&nbsp;Δ
                </th>
                <th className={thCls} scope="col" title="1m momentum">
                  HOT%
                </th>
              </tr>
            </thead>
            <tbody>
              {top5.map((s, idx) => {
                const displayRank = idx + 1;
                const { features } = s;
                const rankChange = rankChanges.get(s.strike) ?? {
                  type: 'same' as const,
                  delta: 0,
                };

                // Dist color: positive = above spot (green), negative = below (red)
                const distColor =
                  features.distFromSpot >= 0 ? theme.green : theme.red;

                // deltaPct_1m color
                const deltaPct1m = features.deltaPct_1m;
                const deltaPctColor =
                  deltaPct1m === null
                    ? theme.textMuted
                    : deltaPct1m >= 0
                      ? theme.green
                      : theme.red;

                // est. Δ — actual net dealer delta in contracts from greek_exposure_strike.
                // Null when the daily greek exposure cron hasn't run yet (pre-market).
                const estDealerDelta =
                  (features.callDelta ?? 0) + (features.putDelta ?? 0);
                const halfW = BAR_MAX_W / 2;
                const dealerBarW =
                  Math.tanh(Math.abs(estDealerDelta) / barStats.cp.scale) *
                  halfW;
                const dealerColor =
                  estDealerDelta >= 0 ? theme.green : theme.red;
                const cpLabel: ReactNode = (
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
                          left:
                            estDealerDelta >= 0 ? halfW : halfW - dealerBarW,
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
                );

                // HOT% — absolute 1m delta pct (deltaPct_1m is a fraction, ×100 for display)
                const hotPct = `${(Math.abs(deltaPct1m ?? 0) * 100).toFixed(0)}%`;
                // Flag strikes with ≥10% 1m move — the threshold Wonce watches for
                // "big delta from previous update" as a predictive signal.
                const isHot = Math.abs(deltaPct1m ?? 0) >= 0.1;

                // GEX color
                const gexColor =
                  features.gexDollars >= 0 ? theme.green : theme.red;

                // Target row highlight
                const rowBg = s.isTarget
                  ? 'rgba(99,102,241,0.10)'
                  : idx % 2 === 1
                    ? 'var(--color-table-alt)'
                    : undefined;

                // Greek bar tooltips
                const charmTooltip =
                  Math.abs(features.charmNet) <=
                  barStats.charm.nearZeroThreshold
                    ? CHEX_TOOLTIPS.zero
                    : features.charmNet > 0
                      ? CHEX_TOOLTIPS.positive
                      : CHEX_TOOLTIPS.negative;

                const deltaTooltip =
                  Math.abs(features.deltaNet) <=
                  barStats.delta.nearZeroThreshold
                    ? DEX_TOOLTIPS.zero
                    : features.deltaNet > 0
                      ? DEX_TOOLTIPS.positive
                      : DEX_TOOLTIPS.negative;

                const vannaTooltip =
                  Math.abs(features.vannaNet) <=
                  barStats.vanna.nearZeroThreshold
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
                    key={s.strike}
                    style={{ backgroundColor: rowBg }}
                    aria-current={s.isTarget ? 'true' : undefined}
                  >
                    {/* RK — sequential 1-5 within the displayed board */}
                    <td
                      className={tdCls}
                      style={{ color: theme.textSecondary }}
                    >
                      {displayRank}
                    </td>

                    {/* Rank change */}
                    <td className={tdCls} style={{ fontSize: 10 }}>
                      <RankArrow info={rankChange} />
                    </td>

                    {/* Strike */}
                    <td className={tdCls} style={{ color: theme.text }}>
                      {s.strike}
                    </td>

                    {/* Dist */}
                    <td className={tdCls} style={{ color: distColor }}>
                      {formatDist(features.distFromSpot)}
                    </td>

                    {/* Δ% */}
                    <td className={tdCls} style={{ color: deltaPctColor }}>
                      {formatDeltaPct(features.deltaPct_1m)}
                    </td>

                    {/* CHEX — title on <td> so full cell triggers tooltip */}
                    <td className={tdCls} title={charmTooltip}>
                      <GreekBar
                        value={features.charmNet}
                        scale={barStats.charm.scale}
                        nearZeroThreshold={barStats.charm.nearZeroThreshold}
                      />
                    </td>

                    {/* DEX */}
                    <td className={tdCls} title={deltaTooltip}>
                      <GreekBar
                        value={features.deltaNet}
                        scale={barStats.delta.scale}
                        nearZeroThreshold={barStats.delta.nearZeroThreshold}
                      />
                    </td>

                    {/* VEX */}
                    <td className={tdCls} title={vannaTooltip}>
                      <GreekBar
                        value={features.vannaNet}
                        scale={barStats.vanna.scale}
                        nearZeroThreshold={barStats.vanna.nearZeroThreshold}
                      />
                    </td>

                    {/* GEX $ */}
                    <td className={tdCls} style={{ color: gexColor }}>
                      {formatGex(features.gexDollars)}
                    </td>

                    {/* C/P */}
                    <td className={tdCls} title={cpTooltip}>
                      {cpLabel}
                    </td>

                    {/* HOT% */}
                    <td className={tdCls}>
                      <span
                        className="rounded px-1 py-0.5 text-[10px]"
                        style={{
                          backgroundColor: isHot
                            ? 'rgba(255,180,0,0.15)'
                            : 'rgba(255,255,255,0.06)',
                          color: isHot ? '#ffb300' : theme.textSecondary,
                          border: isHot
                            ? '1px solid rgba(255,180,0,0.35)'
                            : undefined,
                          fontWeight: isHot ? 700 : undefined,
                        }}
                      >
                        {hotPct}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollHint>
      )}
    </SectionBox>
  );
});
