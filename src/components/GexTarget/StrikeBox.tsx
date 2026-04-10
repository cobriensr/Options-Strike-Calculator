/**
 * StrikeBox — Panel 5: dense sofbot-style leaderboard with greek bars.
 *
 * Shows up to 10 strikes with rank, rank-change arrow, strike price,
 * distance from spot, 1m delta%, CHEX/DEX/VEX greek bars, GEX $, C/P
 * flow ratio, and HOT% badge.
 *
 * Rank-change tracking: a useState holds the previous render's rank map
 * so per-row ▲/▼/— arrows can be computed safely during render.
 *
 * Greek bar sizing uses tanh(|value| / scale) where scale = median
 * abs(value) across the 10-strike universe, recomputed on every render.
 * Near-zero threshold = 5th percentile of abs(value); below it the bar
 * is rendered in muted gray.
 */

import { memo, useEffect, useMemo, useState } from 'react';
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
  tooltip: string;
}

const GreekBar = memo(function GreekBar({
  value,
  scale,
  nearZeroThreshold,
  tooltip,
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
    <div
      style={{ width: BAR_MAX_W, height: BAR_H, position: 'relative' }}
      title={tooltip}
      aria-label={tooltip.split('\n')[0]}
    >
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

type RankChange = 'up' | 'down' | 'same' | 'new';

function RankArrow({ change }: Readonly<{ change: RankChange }>) {
  if (change === 'up')
    return (
      <span style={{ color: theme.green }} aria-label="Rank improved">
        &#9650;
      </span>
    );
  if (change === 'down')
    return (
      <span style={{ color: theme.red }} aria-label="Rank worsened">
        &#9660;
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
  // Track previous ranks via state so rank-change arrows can be computed
  // safely during render. The effect fires after paint and updates prevRanks
  // for the next leaderboard change — this is the correct React pattern for
  // "previous value" comparisons (arrows show 'new' on first load, 'same'
  // on the effect-triggered second render, then correctly show ▲/▼ on
  // subsequent changes).
  const [prevRanks, setPrevRanks] = useState<Map<number, number>>(
    () => new Map(),
  );
  useEffect(() => {
    const m = new Map<number, number>();
    for (const s of leaderboard) m.set(s.strike, s.rankByScore);
    setPrevRanks(m);
  }, [leaderboard]);

  const rankChanges = useMemo<Map<number, RankChange>>(() => {
    const result = new Map<number, RankChange>();
    for (const s of leaderboard) {
      const prevRank = prevRanks.get(s.strike);
      let change: RankChange;
      if (prevRank === undefined) {
        change = 'new';
      } else if (s.rankByScore < prevRank) {
        change = 'up';
      } else if (s.rankByScore > prevRank) {
        change = 'down';
      } else {
        change = 'same';
      }
      result.set(s.strike, change);
    }
    return result;
  }, [leaderboard, prevRanks]);

  // Compute per-greek bar stats once per render
  const barStats = useMemo(() => {
    const charmVals = leaderboard.map((s) => s.features.charmNet);
    const deltaVals = leaderboard.map((s) => s.features.deltaNet);
    const vannaVals = leaderboard.map((s) => s.features.vannaNet);
    return {
      charm: computeBarStats(charmVals),
      delta: computeBarStats(deltaVals),
      vanna: computeBarStats(vannaVals),
    };
  }, [leaderboard]);

  // Header cell style
  const thCls =
    'px-1.5 py-1 text-[10px] uppercase tracking-wide font-mono text-left whitespace-nowrap';
  const tdCls = 'px-1.5 py-1.5 text-[11px] font-mono whitespace-nowrap';

  return (
    <SectionBox label="GEX STRIKE BOARD">
      {leaderboard.length === 0 ? (
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
                <th className={thCls} scope="col" title="Call/Put flow ratio">
                  C/P
                </th>
                <th className={thCls} scope="col" title="1m momentum">
                  HOT%
                </th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((s, idx) => {
                const { features } = s;
                const rankChange = rankChanges.get(s.strike) ?? 'same';

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

                // C/P flow ratio display
                const cr = features.callRatio;
                const cpAbsPct = `${Math.round(Math.abs(cr) * 100)}%`;
                let cpLabel: ReactNode;
                if (Math.abs(cr) < 0.01) {
                  cpLabel = (
                    <span style={{ color: theme.textMuted }}>&mdash;</span>
                  );
                } else if (cr > 0) {
                  cpLabel = (
                    <span style={{ color: theme.green }}>
                      C&thinsp;{cpAbsPct}
                    </span>
                  );
                } else {
                  cpLabel = (
                    <span style={{ color: theme.red }}>
                      P&thinsp;{cpAbsPct}
                    </span>
                  );
                }

                // HOT% — absolute 1m delta pct
                const hotPct = `${Math.abs(deltaPct1m ?? 0).toFixed(0)}%`;

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

                return (
                  <tr
                    key={s.strike}
                    style={{ backgroundColor: rowBg }}
                    aria-current={s.isTarget ? 'true' : undefined}
                  >
                    {/* RK */}
                    <td
                      className={tdCls}
                      style={{ color: theme.textSecondary }}
                    >
                      {s.rankByScore}
                    </td>

                    {/* Rank change */}
                    <td className={tdCls} style={{ fontSize: 10 }}>
                      <RankArrow change={rankChange} />
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

                    {/* CHEX */}
                    <td className={tdCls}>
                      <GreekBar
                        value={features.charmNet}
                        scale={barStats.charm.scale}
                        nearZeroThreshold={barStats.charm.nearZeroThreshold}
                        tooltip={charmTooltip}
                      />
                    </td>

                    {/* DEX */}
                    <td className={tdCls}>
                      <GreekBar
                        value={features.deltaNet}
                        scale={barStats.delta.scale}
                        nearZeroThreshold={barStats.delta.nearZeroThreshold}
                        tooltip={deltaTooltip}
                      />
                    </td>

                    {/* VEX */}
                    <td className={tdCls}>
                      <GreekBar
                        value={features.vannaNet}
                        scale={barStats.vanna.scale}
                        nearZeroThreshold={barStats.vanna.nearZeroThreshold}
                        tooltip={vannaTooltip}
                      />
                    </td>

                    {/* GEX $ */}
                    <td className={tdCls} style={{ color: gexColor }}>
                      {formatGex(features.gexDollars)}
                    </td>

                    {/* C/P */}
                    <td className={tdCls}>{cpLabel}</td>

                    {/* HOT% */}
                    <td className={tdCls}>
                      <span
                        className="rounded px-1 py-0.5 text-[10px]"
                        style={{
                          backgroundColor: 'rgba(255,255,255,0.06)',
                          color: theme.textSecondary,
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
