/**
 * BiasPanel — structural bias verdict block rendered above the strike table.
 *
 * Shows:
 *   • Verdict label + description with a positional regime badge
 *   • GEX Gravity (strike with the largest |GEX|)
 *   • Top 2 upside and downside drift targets with classification + vol flag
 *   • 1m / 5m / 10m floor + ceiling Δ% trend ladder (Phase 4: all three
 *     windows at GexBot's native 1-min cadence)
 */

import {
  CLASS_META,
  CLS_TOOLTIP,
  VERDICT_META,
  VERDICT_TOOLTIP,
} from './constants';
import { fmtGex, fmtPct } from './formatters';
import type { BiasMetrics, DriftTarget } from './types';

export interface BiasPanelProps {
  bias: BiasMetrics;
  /** Strike with the largest |Δ1m|; used for the ⚡ confluence marker. */
  maxChanged1mStrike: number | null;
  /** Strike with the largest |Δ5m|; used for the ⚡ confluence marker. */
  maxChanged5mStrike: number | null;
  /** Strike with the largest |Δ10m|; used for the ⚡ confluence marker. */
  maxChanged10mStrike: number | null;
}

/**
 * Pick the cell color for a floor-trend value. Floor growing (positive
 * % Δ) is bullish — support is hardening; the gradient stays green.
 */
function floorTrendColor(v: number | null): string {
  if (v === null) return 'var(--color-muted)';
  return v >= 0 ? '#4ade80' : '#f87171';
}

/**
 * Pick the cell color for a ceiling-trend value. Ceiling shrinking
 * (negative % Δ) is bullish — overhead resistance is weakening; the
 * positive direction is amber (resistance building).
 */
function ceilTrendColor(v: number | null): string {
  if (v === null) return 'var(--color-muted)';
  return v <= 0 ? '#4ade80' : '#fbbf24';
}

export function BiasPanel({
  bias,
  maxChanged1mStrike,
  maxChanged5mStrike,
  maxChanged10mStrike,
}: BiasPanelProps) {
  const vm = VERDICT_META[bias.verdict];
  const isDrifting =
    bias.verdict === 'drifting-down' || bias.verdict === 'drifting-up';
  const driftSuffix =
    isDrifting && bias.priceTrend
      ? ` (${bias.priceTrend.changePts > 0 ? '+' : ''}${bias.priceTrend.changePts.toFixed(1)} pts / 30m)`
      : '';

  return (
    <div className={`mb-3 rounded-lg border p-3 ${vm.bg} ${vm.border}`}>
      {/* Verdict + Regime */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            className={`cursor-help rounded border px-2 py-0.5 font-mono text-[11px] font-bold ${vm.color} ${vm.bg} ${vm.border}`}
            title={VERDICT_TOOLTIP[bias.verdict]}
          >
            {vm.label}
          </span>
          <span className="text-secondary font-mono text-[11px]">
            {vm.desc}
            {driftSuffix && (
              <span className={`font-semibold ${vm.color}`}>{driftSuffix}</span>
            )}
          </span>
        </div>
        <span
          className={`shrink-0 cursor-help rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${bias.regime === 'positive' ? 'bg-sky-500/20 text-sky-400' : 'bg-amber-500/20 text-amber-400'}`}
          title={
            bias.regime === 'positive'
              ? 'MMs are net long gamma — they trade against moves, buying dips and selling rips like shock absorbers. Expect tighter ranges and faded breakouts today.'
              : 'MMs are net short gamma — they trade with moves, buying rallies and selling drops like fuel. Expect wider ranges and breakouts that accelerate today.'
          }
        >
          {bias.regime === 'positive'
            ? 'POS GEX — dampened'
            : 'NEG GEX — trending'}{' '}
          <span className="font-normal opacity-70">
            {fmtGex(bias.totalNetGex)}
          </span>
        </span>
      </div>

      {/* Metrics row — gravity, drift targets, and the 3-row trend ladder */}
      <div className="grid grid-cols-[auto_1px_1fr_1px_1fr_1px_auto] items-start gap-x-4">
        {/* GEX gravity */}
        <div
          className="cursor-help"
          title="The single strike with the largest absolute GEX in the window. This is where MMs have the heaviest hedge book and do the most delta hedging. Price naturally drifts toward this level over the session."
        >
          <div
            className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--color-tertiary)' }}
          >
            GEX Gravity
          </div>
          <div
            className="font-mono text-[13px] font-semibold"
            style={{ color: 'var(--color-primary)' }}
          >
            {bias.gravityOffset === 0
              ? 'ATM'
              : `${bias.gravityOffset > 0 ? '↑' : '↓'} ${Math.abs(
                  bias.gravityOffset,
                ).toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}pts`}
          </div>
          <div
            className="font-mono text-[10px]"
            style={{ color: 'var(--color-secondary)' }}
          >
            {bias.gravityStrike.toLocaleString()} · {fmtGex(bias.gravityGex)}
          </div>
        </div>

        {/* Divider */}
        <div className="h-full w-px bg-white/10" />

        {/* Upside drift targets */}
        <DriftTargetColumn
          label="↑ Drift Targets"
          title="Top 2 strikes above spot by absolute GEX — where the most MM hedging activity sits overhead. Positive regime: price gets pulled toward the first target. Negative regime: a break through can accelerate toward the second."
          targets={bias.upsideTargets}
          strikeColor="text-emerald-400"
          maxChanged1mStrike={maxChanged1mStrike}
          maxChanged5mStrike={maxChanged5mStrike}
          maxChanged10mStrike={maxChanged10mStrike}
        />

        {/* Divider */}
        <div className="h-full w-px bg-white/10" />

        {/* Downside drift targets */}
        <DriftTargetColumn
          label="↓ Drift Targets"
          title="Top 2 strikes below spot by absolute GEX — where the most MM hedging activity sits below you. Positive regime: price gets pulled toward the first target. Negative regime: a break through can accelerate toward the second."
          targets={bias.downsideTargets}
          strikeColor="text-red-400"
          maxChanged1mStrike={maxChanged1mStrike}
          maxChanged5mStrike={maxChanged5mStrike}
          maxChanged10mStrike={maxChanged10mStrike}
        />

        {/* Divider */}
        <div className="h-full w-px bg-white/10" />

        {/* Trend ladder — 1m / 5m / 10m floor + ceiling */}
        <TrendLadder bias={bias} />
      </div>
    </div>
  );
}

interface DriftTargetColumnProps {
  label: string;
  title: string;
  targets: DriftTarget[];
  strikeColor: string;
  maxChanged1mStrike: number | null;
  maxChanged5mStrike: number | null;
  maxChanged10mStrike: number | null;
}

function DriftTargetColumn({
  label,
  title,
  targets,
  strikeColor,
  maxChanged1mStrike,
  maxChanged5mStrike,
  maxChanged10mStrike,
}: DriftTargetColumnProps) {
  return (
    <div title={title}>
      <div
        className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
        style={{ color: 'var(--color-tertiary)' }}
      >
        {label}
      </div>
      {targets.length === 0 ? (
        <div
          className="font-mono text-[12px]"
          style={{ color: 'var(--color-muted)' }}
        >
          —
        </div>
      ) : (
        targets.map((t) => {
          const isConfluence =
            t.strike === maxChanged1mStrike ||
            t.strike === maxChanged5mStrike ||
            t.strike === maxChanged10mStrike;
          return (
            <div
              key={t.strike}
              className="flex items-baseline gap-1.5"
              title={CLS_TOOLTIP[t.cls]}
            >
              <span
                className={`font-mono text-[12px] font-semibold ${strikeColor}`}
              >
                {t.strike.toLocaleString()}
              </span>
              <span
                className={`font-mono text-[9px] ${CLASS_META[t.cls].badgeText}`}
              >
                {CLASS_META[t.cls].badge}
              </span>
              <span
                className="font-mono text-[9px]"
                style={{ color: t.netGamma >= 0 ? '#4ade80' : '#fbbf24' }}
              >
                {fmtGex(t.netGamma)}
              </span>
              {t.volReinforcement === 'reinforcing' && (
                <span
                  className="font-mono text-[9px] text-emerald-400"
                  title="Reinforcing — delta-trend agrees with the wall"
                >
                  ↑↑
                </span>
              )}
              {t.volReinforcement === 'opposing' && (
                <span
                  className="font-mono text-[9px] text-red-400"
                  title="Opposing — delta-trend pushes against the wall"
                >
                  ↓↓
                </span>
              )}
              {isConfluence && (
                <span
                  className="font-mono text-[9px] text-amber-400"
                  title="Most actively changing GEX level — high-conviction target"
                >
                  ⚡
                </span>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

interface TrendLadderProps {
  bias: BiasMetrics;
}

/**
 * Three-row trend ladder: 1m / 5m / 10m, each row showing both floor and
 * ceiling Δ% averages. Replaces the legacy single 10m/30m display from
 * the MM era.
 */
function TrendLadder({ bias }: TrendLadderProps) {
  const rows: Array<{
    label: string;
    floor: number | null;
    ceil: number | null;
  }> = [
    { label: '1m', floor: bias.floorTrend1m, ceil: bias.ceilingTrend1m },
    { label: '5m', floor: bias.floorTrend5m, ceil: bias.ceilingTrend5m },
    { label: '10m', floor: bias.floorTrend10m, ceil: bias.ceilingTrend10m },
  ];

  return (
    <div
      className="cursor-help"
      title="Average % change in MM dollar gamma for strikes above (Ceil) and below (Floor) spot vs. the slot N min ago. Floor growing (green) = support hardening. Ceiling growing (amber) = resistance building. Ceiling shrinking (green) = overhead wall weakening. Three rows at GexBot's native 1-min cadence."
    >
      <div
        className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
        style={{ color: 'var(--color-tertiary)' }}
      >
        Trend Ladder
      </div>
      <div className="grid grid-cols-[auto_auto_auto] items-baseline gap-x-2">
        {rows.map((r) => (
          <TrendRow
            key={r.label}
            label={r.label}
            floor={r.floor}
            ceil={r.ceil}
          />
        ))}
      </div>
    </div>
  );
}

interface TrendRowProps {
  label: string;
  floor: number | null;
  ceil: number | null;
}

function TrendRow({ label, floor, ceil }: TrendRowProps) {
  return (
    <>
      <span
        className="font-mono text-[9px] font-semibold"
        style={{ color: 'var(--color-tertiary)' }}
      >
        {label}
      </span>
      <span
        className="font-mono text-[11px] font-semibold"
        style={{ color: floorTrendColor(floor) }}
        title={`Floor (avg Δ${label} below spot)`}
      >
        F {fmtPct(floor)}
      </span>
      <span
        className="font-mono text-[11px] font-semibold"
        style={{ color: ceilTrendColor(ceil) }}
        title={`Ceiling (avg Δ${label} above spot)`}
      >
        C {fmtPct(ceil)}
      </span>
    </>
  );
}
