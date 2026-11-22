/**
 * BiasPanel — structural bias verdict block rendered above the strike table.
 *
 * Shows:
 *   • Verdict label + description with the net taker gamma badge
 *   • Top |γ| strike (the strike with the largest |γ|)
 *   • Top 2 strikes above and below spot by |γ| with classification + vol flag
 *   • 5m / 15m / 30m below-spot (F) + above-spot (C) Δ% trend ladder
 *     (all three windows from GEXBot's t-5 / t-15 / t-30 min priors)
 *
 * All text describes GEXBot taker-side positioning; none of it predicts
 * market-maker hedging (owner decision D1 revised, 2026-10-29).
 */

import {
  CLASS_META,
  CLS_TOOLTIP,
  GAMMA_SIGN_CLASSES,
  VERDICT_META,
  VERDICT_TOOLTIP,
  VERDICT_TOOLTIP_TAIL,
  takerSignHex,
  trendColor,
} from './constants';
import { fmtGex, fmtPct } from './formatters';
import type { BiasMetrics, DriftTarget } from './types';
import { SrHint } from '../ui/SrHint.js';

/**
 * Hover text that is also read aloud. Each element keeps it as its `title`
 * and carries it as a hidden `SrHint` too (or, for the three glyph-only
 * marks, as the `role="img"` label), because a `title` alone never reaches a
 * screen reader. One constant per text, so the two cannot drift apart.
 */
const TOP_GAMMA_TEXT =
  'The strike with the largest absolute GEXBot gamma within ±50 pts of spot: its distance from spot, strike and taker-side value.';
const REINFORCING_MARK_TEXT =
  "Reinforcing — Δ5m, Δ15m and Δ30m all move with this strike's gamma sign, so its gamma is growing in that sign";
const OPPOSING_MARK_TEXT =
  "Opposing — Δ5m, Δ15m and Δ30m all move against this strike's gamma sign, so its gamma is shrinking toward zero";
const CONFLUENCE_MARK_TEXT =
  'Most actively changing gamma strike (largest |Δ| in a 5m, 15m or 30m window)';

/**
 * Trend ladder: the title opens with "Average % change", so the hint is a
 * trimmed variant that also says what F and C are, since the cells show only
 * the letters.
 */
const TREND_LADDER_HINT =
  'average % change in GEXBot dollar gamma in taker-side sign. F is the strikes more than 25 pts below spot and C the strikes more than 25 pts above, each against the value 5, 15 and 30 min ago';

export interface BiasPanelProps {
  bias: BiasMetrics;
  /** Strike with the largest |Δ5m|; used for the ⚡ confluence marker. */
  maxChanged5mStrike: number | null;
  /** Strike with the largest |Δ15m|; used for the ⚡ confluence marker. */
  maxChanged15mStrike: number | null;
  /** Strike with the largest |Δ30m|; used for the ⚡ confluence marker. */
  maxChanged30mStrike: number | null;
}

export function BiasPanel({
  bias,
  maxChanged5mStrike,
  maxChanged15mStrike,
  maxChanged30mStrike,
}: BiasPanelProps) {
  const vm = VERDICT_META[bias.verdict];
  // Net-gamma badge: same sign hues as the verdicts and class tints.
  const regimeTone =
    GAMMA_SIGN_CLASSES[bias.regime === 'positive' ? 'long' : 'short'];
  const isDrifting =
    bias.verdict === 'drifting-down' || bias.verdict === 'drifting-up';
  const driftSuffix =
    isDrifting && bias.priceTrend
      ? ` (${bias.priceTrend.changePts > 0 ? '+' : ''}${bias.priceTrend.changePts.toFixed(1)} pts / 30m)`
      : '';
  const regimeHint =
    bias.regime === 'positive'
      ? "Sum of GEXBot gamma over the strikes within ±50 pts of spot, in GEXBot's taker-side sign: positive, so traders (takers) are net long gamma across the window."
      : "Sum of GEXBot gamma over the strikes within ±50 pts of spot, in GEXBot's taker-side sign: negative, so traders (takers) are net short gamma across the window.";

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
            {/* The rest of the title repeats the description beside it. */}
            <SrHint>{VERDICT_TOOLTIP_TAIL}</SrHint>
          </span>
          <span className="text-secondary font-mono text-[11px]">
            {vm.desc}
            {driftSuffix && (
              <span className={`font-semibold ${vm.color}`}>{driftSuffix}</span>
            )}
          </span>
        </div>
        <span
          className={`shrink-0 cursor-help rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${regimeTone.bg} ${regimeTone.color}`}
          title={regimeHint}
        >
          {bias.regime === 'positive' ? 'NET LONG γ' : 'NET SHORT γ'}{' '}
          <span className="font-normal opacity-70">
            {fmtGex(bias.totalNetGex)}
          </span>
          <SrHint>{regimeHint}</SrHint>
        </span>
      </div>

      {/* Metrics row — top |γ| strike, top strikes either side, trend ladder */}
      <div className="grid grid-cols-[auto_1px_1fr_1px_1fr_1px_auto] items-start gap-x-4">
        {/* Top |γ| strike (`gravity*` fields) */}
        <div className="cursor-help" title={TOP_GAMMA_TEXT}>
          <div
            className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--color-tertiary)' }}
          >
            Top |γ| strike
          </div>
          <div
            className="font-mono text-[13px] font-semibold"
            style={{ color: 'var(--color-primary)' }}
          >
            {bias.gravityOffset === 0
              ? 'ATM'
              : `${bias.gravityOffset > 0 ? '▲' : '▼'} ${Math.abs(
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
          <SrHint>{TOP_GAMMA_TEXT}</SrHint>
        </div>

        {/* Divider */}
        <div className="h-full w-px bg-white/10" />

        {/* Top |γ| strikes above spot */}
        <DriftTargetColumn
          label="▲ Top |γ| above"
          title="The two strikes more than 25 pts above spot with the largest absolute GEXBot gamma, with their taker-side classification."
          targets={bias.upsideTargets}
          strikeColor="text-emerald-400"
          maxChanged5mStrike={maxChanged5mStrike}
          maxChanged15mStrike={maxChanged15mStrike}
          maxChanged30mStrike={maxChanged30mStrike}
        />

        {/* Divider */}
        <div className="h-full w-px bg-white/10" />

        {/* Top |γ| strikes below spot */}
        <DriftTargetColumn
          label="▼ Top |γ| below"
          title="The two strikes more than 25 pts below spot with the largest absolute GEXBot gamma, with their taker-side classification."
          targets={bias.downsideTargets}
          strikeColor="text-red-400"
          maxChanged5mStrike={maxChanged5mStrike}
          maxChanged15mStrike={maxChanged15mStrike}
          maxChanged30mStrike={maxChanged30mStrike}
        />

        {/* Divider */}
        <div className="h-full w-px bg-white/10" />

        {/* Trend ladder — 5m / 15m / 30m floor + ceiling */}
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
  maxChanged5mStrike: number | null;
  maxChanged15mStrike: number | null;
  maxChanged30mStrike: number | null;
}

function DriftTargetColumn({
  label,
  title,
  targets,
  strikeColor,
  maxChanged5mStrike,
  maxChanged15mStrike,
  maxChanged30mStrike,
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
            t.strike === maxChanged5mStrike ||
            t.strike === maxChanged15mStrike ||
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
                style={{ color: takerSignHex(t.netGamma) }}
              >
                {fmtGex(t.netGamma)}
              </span>
              {t.volReinforcement === 'reinforcing' && (
                <span
                  className="text-secondary font-mono text-[9px]"
                  title={REINFORCING_MARK_TEXT}
                  role="img"
                  aria-label={REINFORCING_MARK_TEXT}
                >
                  ↑↑
                </span>
              )}
              {t.volReinforcement === 'opposing' && (
                <span
                  className="text-secondary font-mono text-[9px]"
                  title={OPPOSING_MARK_TEXT}
                  role="img"
                  aria-label={OPPOSING_MARK_TEXT}
                >
                  ↓↓
                </span>
              )}
              {isConfluence && (
                <span
                  className="font-mono text-[9px] text-amber-400"
                  title={CONFLUENCE_MARK_TEXT}
                  role="img"
                  aria-label={CONFLUENCE_MARK_TEXT}
                >
                  ⚡
                </span>
              )}
              <SrHint>{CLS_TOOLTIP[t.cls]}</SrHint>
            </div>
          );
        })
      )}
      <SrHint>{title}</SrHint>
    </div>
  );
}

interface TrendLadderProps {
  bias: BiasMetrics;
}

/**
 * Three-row trend ladder: 5m / 15m / 30m, each row showing the average Δ%
 * below spot (F) and above spot (C). Replaces the legacy single 10m/30m
 * display from the MM era.
 */
function TrendLadder({ bias }: TrendLadderProps) {
  const rows: Array<{
    label: string;
    floor: number | null;
    ceil: number | null;
  }> = [
    { label: '5m', floor: bias.floorTrend5m, ceil: bias.ceilingTrend5m },
    { label: '15m', floor: bias.floorTrend15m, ceil: bias.ceilingTrend15m },
    { label: '30m', floor: bias.floorTrend30m, ceil: bias.ceilingTrend30m },
  ];

  return (
    <div
      className="cursor-help"
      title="Average % change in GEXBot dollar gamma (taker-side sign) for the strikes more than 25 pts below spot (F) and above spot (C), vs. the value N min ago. Three rows at GEXBot's priors windows (t-5 / t-15 / t-30 min)."
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
      <SrHint>{TREND_LADDER_HINT}</SrHint>
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
        style={{ color: trendColor(floor) }}
        title={`F: avg Δ${label} of the strikes below spot`}
      >
        F {fmtPct(floor)}
        <SrHint>{`average Δ${label} of the strikes below spot`}</SrHint>
      </span>
      <span
        className="font-mono text-[11px] font-semibold"
        style={{ color: trendColor(ceil) }}
        title={`C: avg Δ${label} of the strikes above spot`}
      >
        C {fmtPct(ceil)}
        <SrHint>{`average Δ${label} of the strikes above spot`}</SrHint>
      </span>
    </>
  );
}
