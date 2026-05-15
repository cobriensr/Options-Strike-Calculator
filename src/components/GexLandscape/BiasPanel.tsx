/**
 * BiasPanel — structural bias verdict block rendered above the strike table.
 *
 * Shows:
 *   • Verdict label + description with a positional regime badge
 *   • GEX Gravity (strike with the largest |GEX|)
 *   • Top 2 upside and downside drift targets with classification + vol flag
 *   • 10m and 30m ceiling/floor GEX trends (MM cadence)
 */

import {
  CLASS_META,
  CLS_TOOLTIP,
  VERDICT_META,
  VERDICT_TOOLTIP,
} from './constants';
import { fmtGex, fmtPct } from './formatters';
import type {
  BiasMetrics,
  DriftTarget,
  NaiveBiasMetrics,
  NaiveDriftTarget,
} from './types';

export interface BiasPanelProps {
  bias: BiasMetrics;
  /** Strike with the largest |10m Δ%|; used for the ⚡ confluence marker. */
  maxChanged10mStrike: number | null;
  /** Strike with the largest |30m Δ%|; used for the ⚡ confluence marker. */
  maxChanged30mStrike: number | null;
}

export function BiasPanel({
  bias,
  maxChanged10mStrike,
  maxChanged30mStrike,
}: BiasPanelProps) {
  const vm = VERDICT_META[bias.verdict];
  const isDrifting =
    bias.verdict === 'drifting-down' || bias.verdict === 'drifting-up';
  const driftSuffix =
    isDrifting && bias.priceTrend
      ? ` (${bias.priceTrend.changePts > 0 ? '+' : ''}${bias.priceTrend.changePts.toFixed(1)} pts / 30m)`
      : '';
  const floorTrend10mColor =
    bias.floorTrend10m === null
      ? 'var(--color-muted)'
      : bias.floorTrend10m >= 0
        ? '#4ade80'
        : '#f87171';
  const ceilTrend10mColor =
    bias.ceilingTrend10m === null
      ? 'var(--color-muted)'
      : bias.ceilingTrend10m <= 0
        ? '#4ade80'
        : '#fbbf24';
  const floorTrend30mColor =
    bias.floorTrend30m === null
      ? 'var(--color-muted)'
      : bias.floorTrend30m >= 0
        ? '#4ade80'
        : '#f87171';
  const ceilTrend30mColor =
    bias.ceilingTrend30m === null
      ? 'var(--color-muted)'
      : bias.ceilingTrend30m <= 0
        ? '#4ade80'
        : '#fbbf24';

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

      {/* Metrics row */}
      <div className="grid grid-cols-[auto_1px_1fr_1px_1fr_1px_auto_1px_auto] items-start gap-x-4">
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
          <NaiveGravitySubLine naive={bias.naive} />
        </div>

        {/* Divider */}
        <div className="h-full w-px bg-white/10" />

        {/* Upside drift targets */}
        <DriftTargetColumn
          label="↑ Drift Targets"
          title="Top 2 strikes above spot by absolute GEX — where the most MM hedging activity sits overhead. Positive regime: price gets pulled toward the first target. Negative regime: a break through can accelerate toward the second."
          targets={bias.upsideTargets}
          strikeColor="text-emerald-400"
          maxChanged10mStrike={maxChanged10mStrike}
          maxChanged30mStrike={maxChanged30mStrike}
          naiveTargets={bias.naive?.upsideTargets ?? null}
        />

        {/* Divider */}
        <div className="h-full w-px bg-white/10" />

        {/* Downside drift targets */}
        <DriftTargetColumn
          label="↓ Drift Targets"
          title="Top 2 strikes below spot by absolute GEX — where the most MM hedging activity sits below you. Positive regime: price gets pulled toward the first target. Negative regime: a break through can accelerate toward the second."
          targets={bias.downsideTargets}
          strikeColor="text-red-400"
          maxChanged10mStrike={maxChanged10mStrike}
          maxChanged30mStrike={maxChanged30mStrike}
          naiveTargets={bias.naive?.downsideTargets ?? null}
        />

        {/* Divider */}
        <div className="h-full w-px bg-white/10" />

        {/* 10m Trend */}
        <TrendColumn
          label="10m Trend"
          title="Average % change in MM dollar gamma for strikes above (Ceil) and below (Floor) spot vs. the prior 10-min slot. Floor growing (green) = support hardening. Ceiling growing (amber) = resistance building. Ceiling shrinking (green) = that overhead wall is weakening."
          floorValue={bias.floorTrend10m}
          ceilValue={bias.ceilingTrend10m}
          floorColor={floorTrend10mColor}
          ceilColor={ceilTrend10mColor}
          naiveFloorValue={bias.naive?.floorTrend10m ?? null}
          naiveCeilValue={bias.naive?.ceilingTrend10m ?? null}
        />

        {/* Divider */}
        <div className="h-full w-px bg-white/10" />

        {/* 30m Trend */}
        <TrendColumn
          label="30m Trend"
          title="Average % change in MM dollar gamma for strikes above (Ceil) and below (Floor) spot vs. the slot 30 min ago. Confirms whether the 10m trend is part of a sustained session-scale move or just a single-slot spike."
          floorValue={bias.floorTrend30m}
          ceilValue={bias.ceilingTrend30m}
          floorColor={floorTrend30mColor}
          ceilColor={ceilTrend30mColor}
          naiveFloorValue={bias.naive?.floorTrend30m ?? null}
          naiveCeilValue={bias.naive?.ceilingTrend30m ?? null}
        />
      </div>
    </div>
  );
}

/**
 * One-liner naive gravity readout shown directly under the MM gravity
 * block. Renders nothing when no naive data is available so the
 * panel collapses cleanly on first paint or for tickers without WS.
 */
function NaiveGravitySubLine({ naive }: { naive: NaiveBiasMetrics | null }) {
  if (naive === null) return null;
  return (
    <div
      className="mt-0.5 font-mono text-[9px]"
      style={{ color: 'var(--color-muted)' }}
      title="Naive — same gravity logic computed over raw call_gamma_oi + put_gamma_oi (WS feed, unattributed)."
    >
      Naive {naive.gravityStrike.toLocaleString()} · {fmtGex(naive.gravityGex)}
    </div>
  );
}

interface DriftTargetColumnProps {
  label: string;
  title: string;
  targets: DriftTarget[];
  strikeColor: string;
  maxChanged10mStrike: number | null;
  maxChanged30mStrike: number | null;
  /** Naive parallel — rendered under MM list when non-null and non-empty. */
  naiveTargets: NaiveDriftTarget[] | null;
}

function DriftTargetColumn({
  label,
  title,
  targets,
  strikeColor,
  maxChanged10mStrike,
  maxChanged30mStrike,
  naiveTargets,
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
            t.strike === maxChanged10mStrike ||
            t.strike === maxChanged30mStrike;
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
                  title="Volume confirms OI structure here"
                >
                  ✓
                </span>
              )}
              {t.volReinforcement === 'opposing' && (
                <span
                  className="font-mono text-[9px] text-red-400"
                  title="Volume contradicts OI structure here"
                >
                  ✗
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
      {naiveTargets !== null && naiveTargets.length > 0 && (
        <div
          className="mt-0.5"
          title="Naive — top targets computed over raw call_gamma_oi + put_gamma_oi (WS feed, unattributed). Can rank differently than MM at the same time."
        >
          {naiveTargets.map((t) => (
            <div
              key={`naive-${t.strike}`}
              className="flex items-baseline gap-1.5 font-mono text-[9px]"
              style={{ color: 'var(--color-muted)' }}
            >
              <span>Naive</span>
              <span>{t.strike.toLocaleString()}</span>
              <span style={{ color: t.netGamma >= 0 ? '#4ade80' : '#fbbf24' }}>
                {fmtGex(t.netGamma)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface TrendColumnProps {
  label: string;
  title: string;
  floorValue: number | null;
  ceilValue: number | null;
  floorColor: string;
  ceilColor: string;
  /** Naive parallel — when both are null (no WS data), the sub-line is suppressed. */
  naiveFloorValue: number | null;
  naiveCeilValue: number | null;
}

function TrendColumn({
  label,
  title,
  floorValue,
  ceilValue,
  floorColor,
  ceilColor,
  naiveFloorValue,
  naiveCeilValue,
}: TrendColumnProps) {
  const hasNaive = naiveFloorValue !== null || naiveCeilValue !== null;
  return (
    <div className="cursor-help" title={title}>
      <div
        className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
        style={{ color: 'var(--color-tertiary)' }}
      >
        {label}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          className="font-mono text-[9px]"
          style={{ color: 'var(--color-muted)' }}
        >
          Floor
        </span>
        <span
          className="font-mono text-[12px] font-semibold"
          style={{ color: floorColor }}
        >
          {fmtPct(floorValue)}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          className="font-mono text-[9px]"
          style={{ color: 'var(--color-muted)' }}
        >
          Ceil
        </span>
        <span
          className="font-mono text-[12px] font-semibold"
          style={{ color: ceilColor }}
        >
          {fmtPct(ceilValue)}
        </span>
      </div>
      {hasNaive && (
        <div
          className="mt-0.5 flex items-baseline gap-1.5 font-mono text-[9px]"
          style={{ color: 'var(--color-muted)' }}
          title="Naive — same trend math computed over raw call_gamma_oi + put_gamma_oi from the WS feed."
        >
          <span>Naive</span>
          <span>F {fmtPct(naiveFloorValue)}</span>
          <span>C {fmtPct(naiveCeilValue)}</span>
        </div>
      )}
    </div>
  );
}
