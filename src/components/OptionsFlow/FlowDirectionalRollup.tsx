/**
 * FlowDirectionalRollup — split aggression summary for options flow.
 *
 * After EDA showed raw bullish/bearish labels were misleading (they mix
 * aggressive ask-side flow with absorbed bid-side flow that's usually
 * hedging), this component bifurcates the window into:
 *
 *   - AGGRESSIVE   ask-side ratio ≥ 0.70 — buyer paying up, directional
 *   - ABSORBED     ask-side ratio ≤ 0.30 — seller filling at bid, hedging
 *   - MIXED        everything in between — no clear signal
 *
 * The overall lean badge at the top is computed from the AGGRESSIVE subset
 * only (>1.5× premium skew one way → CALL-HEAVY / PUT-HEAVY AGGRESSION,
 * else AGGRESSION BALANCED, or NO AGGRESSIVE FLOW when the subset is
 * empty). We deliberately renamed from BULLISH/BEARISH to describe *what
 * the flow is doing*, not to predict where price goes.
 *
 * Edge cases:
 *   - spot === null          → "No spot data"
 *   - alertCount === 0       → "No alerts in window"
 *   - all-mixed subset       → single line, no AGGRESSIVE / ABSORBED rows
 *
 * Pure presentational, no hooks, no fetch.
 */

import type { DirectionalRollup, RankedStrike } from '../../hooks/useOptionsFlow';
import { classifyAggression } from '../../utils/flow-aggression';

// ============================================================
// TYPES
// ============================================================

export interface FlowDirectionalRollupProps {
  rollup: DirectionalRollup;
  strikes: RankedStrike[];
  spot: number | null;
  alertCount: number;
  className?: string;
}

interface BucketTotals {
  callCount: number;
  putCount: number;
  callPremium: number;
  putPremium: number;
}

type OverallLean =
  | 'call-heavy'
  | 'put-heavy'
  | 'balanced'
  | 'no-aggressive-flow';

// ============================================================
// FORMATTERS
// ============================================================

function formatPremium(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

// ============================================================
// PURE HELPERS
// ============================================================

const LEAN_RATIO_THRESHOLD = 1.5;

function emptyBucket(): BucketTotals {
  return { callCount: 0, putCount: 0, callPremium: 0, putPremium: 0 };
}

function bucketize(strikes: RankedStrike[]): {
  aggressive: BucketTotals;
  absorbed: BucketTotals;
} {
  const aggressive = emptyBucket();
  const absorbed = emptyBucket();
  for (const s of strikes) {
    const klass = classifyAggression(s.ask_side_ratio);
    if (klass === 'mixed') continue;
    const target = klass === 'aggressive' ? aggressive : absorbed;
    if (s.type === 'call') {
      target.callCount += 1;
      target.callPremium += s.total_premium;
    } else {
      target.putCount += 1;
      target.putPremium += s.total_premium;
    }
  }
  return { aggressive, absorbed };
}

function computeOverallLean(aggressive: BucketTotals): OverallLean {
  const { callPremium, putPremium, callCount, putCount } = aggressive;
  if (callCount === 0 && putCount === 0) return 'no-aggressive-flow';
  if (callPremium > putPremium * LEAN_RATIO_THRESHOLD) return 'call-heavy';
  if (putPremium > callPremium * LEAN_RATIO_THRESHOLD) return 'put-heavy';
  return 'balanced';
}

function leanMetaFor(lean: OverallLean): {
  label: string;
  icon: string;
  badgeClass: string;
} {
  switch (lean) {
    case 'call-heavy':
      return {
        label: 'CALL-HEAVY AGGRESSION',
        icon: '▲',
        badgeClass:
          'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
      };
    case 'put-heavy':
      return {
        label: 'PUT-HEAVY AGGRESSION',
        icon: '▼',
        badgeClass: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
      };
    case 'balanced':
      return {
        label: 'AGGRESSION BALANCED',
        icon: '●',
        badgeClass: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
      };
    case 'no-aggressive-flow':
      return {
        label: 'NO AGGRESSIVE FLOW',
        icon: '○',
        badgeClass: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
      };
  }
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function BucketRow({
  kind,
  bucket,
}: {
  kind: 'aggressive' | 'absorbed';
  bucket: BucketTotals;
}) {
  const isAgg = kind === 'aggressive';
  const heading = isAgg ? 'AGGRESSIVE' : 'ABSORBED';
  const tag = isAgg ? 'ask ≥ 70%' : 'ask ≤ 30%';
  const headingClass = isAgg ? 'text-emerald-300' : 'text-amber-300';
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
      <span
        className={`font-sans text-[10px] font-semibold tracking-wider uppercase ${headingClass}`}
      >
        {heading}
      </span>
      <span className="text-muted text-[10px]">({tag})</span>
      <span className="text-emerald-400">
        {bucket.callCount} call ({formatPremium(bucket.callPremium)})
      </span>
      <span className="text-edge" aria-hidden="true">
        /
      </span>
      <span className="text-rose-400">
        {bucket.putCount} put ({formatPremium(bucket.putPremium)})
      </span>
    </div>
  );
}

// ============================================================
// MAIN
// ============================================================

export function FlowDirectionalRollup({
  strikes,
  spot,
  alertCount,
  className,
}: FlowDirectionalRollupProps) {
  const hasAlerts = alertCount > 0;
  const hasSpot = spot !== null;

  const { aggressive, absorbed } = bucketize(strikes);
  const hasAggressive = aggressive.callCount + aggressive.putCount > 0;
  const hasAbsorbed = absorbed.callCount + absorbed.putCount > 0;
  const lean = computeOverallLean(aggressive);
  const leanMeta = leanMetaFor(lean);

  const showContent = hasSpot && hasAlerts;
  const allMixed = showContent && !hasAggressive && !hasAbsorbed;

  return (
    <div
      className={`border-edge bg-surface flex flex-col gap-2 rounded-lg border px-3 py-2 ${className ?? ''}`}
      role="status"
      aria-label="Options flow directional rollup"
    >
      <div className="flex flex-wrap items-center gap-3">
        {/* Lean badge */}
        <div
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11px] font-bold tracking-wider ${leanMeta.badgeClass}`}
        >
          <span aria-hidden="true" className="font-mono text-[11px]">
            {leanMeta.icon}
          </span>
          <span>{leanMeta.label}</span>
        </div>

        {!hasSpot && (
          <span className="text-muted font-sans text-[11px] italic">
            No spot data
          </span>
        )}

        {hasSpot && !hasAlerts && (
          <span className="text-muted font-sans text-[11px] italic">
            No alerts in window
          </span>
        )}
      </div>

      {showContent && allMixed && (
        <span className="text-muted font-sans text-[11px] italic">
          All flow is mixed — no clear aggression signal
        </span>
      )}

      {showContent && !allMixed && (
        <div className="flex flex-col gap-1">
          {hasAggressive && <BucketRow kind="aggressive" bucket={aggressive} />}
          {hasAbsorbed && <BucketRow kind="absorbed" bucket={absorbed} />}
        </div>
      )}

      {showContent && (
        <span className="text-muted font-sans text-[10px] italic">
          Aggressive = buyer at ask (directional intent). Absorbed = seller at
          bid (hedging).
        </span>
      )}
    </div>
  );
}
