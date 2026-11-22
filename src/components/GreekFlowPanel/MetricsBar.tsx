/**
 * MetricsBar — compact row of derived-signal badges for one cumulative
 * Greek-flow series (one ticker × one field). Designed to sit directly
 * under each FlowChart so the trader sees the chart shape and the
 * derived-signal interpretation in one glance.
 *
 * Three local badges (per field):
 *   - Slope arrow: ↑ rising | ↓ falling | → flat
 *   - Flip badge: only when the cumulative crossed zero in the last
 *     30 minutes; color follows the new sign
 *   - Cliff alert: only when a 10-min Δ ≥ threshold landed in the
 *     14:00–15:00 CT power hour; an "EOD risk" tell
 *
 * One cross-ticker badge:
 *   - Divergence: shown only when this same field has SPY sign ≠ QQQ sign
 *     for the latest cumulative value
 */

import { memo } from 'react';
import type {
  CliffResult,
  DivergenceResult,
  FlipResult,
  SlopeResult,
} from '../../hooks/useGreekFlow';
import { SrHint } from '../ui/SrHint';
import { fmtCompact } from './fmt-compact';

interface MetricsBarProps {
  slope: SlopeResult;
  flip: FlipResult;
  cliff: CliffResult;
  divergence: DivergenceResult;
}

function MetricsBarInner({ slope, flip, cliff, divergence }: MetricsBarProps) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[9px]">
      <SlopeBadge slope={slope} />
      <FlipBadge flip={flip} />
      <CliffBadge cliff={cliff} />
      <DivergenceBadge divergence={divergence} />
    </div>
  );
}

function SlopeBadge({ slope }: { slope: SlopeResult }) {
  if (slope.slope == null) {
    return (
      <span
        role="img"
        aria-label="not enough points to compute the slope"
        className="text-secondary border-edge rounded border px-1 py-px"
        title="Insufficient points for slope"
      >
        —
      </span>
    );
  }
  const arrow = slope.slope > 0 ? '↑' : slope.slope < 0 ? '↓' : '→';
  const color =
    slope.slope > 0
      ? 'text-emerald-400'
      : slope.slope < 0
        ? 'text-rose-400'
        : 'text-secondary';
  const perMin = slope.slope.toFixed(2);
  return (
    <span
      className={`${color} border-edge rounded border px-1 py-px`}
      title={`Slope (last 15 min): ${perMin} per min`}
    >
      {arrow} slope
      <SrHint>{`last 15 min: ${perMin} per min`}</SrHint>
    </span>
  );
}

function FlipBadge({ flip }: { flip: FlipResult }) {
  if (!flip.occurred) return null;
  const color =
    flip.currentSign === 1
      ? 'text-emerald-400 border-emerald-400/40'
      : flip.currentSign === -1
        ? 'text-rose-400 border-rose-400/40'
        : 'text-secondary';
  const time = fmtTime(flip.atTimestamp);
  return (
    <span
      className={`${color} rounded border bg-transparent px-1 py-px`}
      title={`Sign flip in last 30 min at ${time ?? '—'} (mag ${flip.magnitude.toFixed(0)})`}
    >
      flip
      <SrHint>
        {`sign changed within 30 min${atClause(time)} (magnitude ${fmtCompact(flip.magnitude)})`}
      </SrHint>
    </span>
  );
}

function CliffBadge({ cliff }: { cliff: CliffResult }) {
  if (cliff.atTimestamp == null || cliff.magnitude === 0) return null;
  const time = fmtTime(cliff.atTimestamp);
  return (
    <span
      className="rounded border border-amber-400/40 px-1 py-px text-amber-400"
      title={`10-min cliff at ${time ?? '—'} (mag ${cliff.magnitude.toFixed(0)})`}
    >
      cliff
      <SrHint>
        {`over 10 min${atClause(time)} (magnitude ${fmtCompact(cliff.magnitude)})`}
      </SrHint>
    </span>
  );
}

function DivergenceBadge({ divergence }: { divergence: DivergenceResult }) {
  if (!divergence.diverging) return null;
  return (
    <span
      className="rounded border border-violet-400/40 px-1 py-px text-violet-400"
      title="SPY and QQQ have opposite signs on this field"
    >
      ⇄ div
      <SrHint>SPY and QQQ have opposite signs on this field</SrHint>
    </span>
  );
}

/** ", at 1:30 PM" for a hint, or nothing when there is no usable time. */
function atClause(time: string | null): string {
  return time == null ? '' : `, at ${time}`;
}

/** The time of day in Chicago, or null for a missing or invalid timestamp. */
function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

export const MetricsBar = memo(MetricsBarInner);
