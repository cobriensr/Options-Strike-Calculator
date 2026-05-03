/**
 * VerdictTile and VerdictTimeline — render-only components for the
 * Greek Flow verdict. Pure logic + types live in `./verdict-logic`.
 */

import { memo } from 'react';
import type { DivergenceResult, GreekFlowRow } from '../../hooks/useGreekFlow';
import {
  KIND_LABEL,
  computeVerdict,
  computeVerdictTimeline,
  type VerdictKind,
} from './verdict-logic';

const KIND_BOX: Record<VerdictKind, string> = {
  'directional-bull': 'border-emerald-500/40 bg-emerald-500/10',
  'directional-bear': 'border-rose-500/40 bg-rose-500/10',
  'pin-harvest': 'border-amber-500/40 bg-amber-500/10',
  'vol-expansion': 'border-violet-500/40 bg-violet-500/10',
  'no-trade': 'border-edge bg-surface',
};

const KIND_HEADLINE: Record<VerdictKind, string> = {
  'directional-bull': 'text-emerald-300',
  'directional-bear': 'text-rose-300',
  'pin-harvest': 'text-amber-300',
  'vol-expansion': 'text-violet-300',
  'no-trade': 'text-secondary',
};

const KIND_BAR: Record<VerdictKind, string> = {
  'directional-bull': 'bg-emerald-500/80',
  'directional-bear': 'bg-rose-500/80',
  'pin-harvest': 'bg-amber-500/80',
  'vol-expansion': 'bg-violet-500/80',
  'no-trade': 'bg-zinc-700/80',
};

interface VerdictTileProps {
  delta: DivergenceResult;
  vega: DivergenceResult;
}

function VerdictTileInner({ delta, vega }: VerdictTileProps) {
  const v = computeVerdict(delta, vega);
  return (
    <output
      aria-label={`Trade verdict: ${v.headline}`}
      data-testid="greek-flow-verdict"
      data-verdict-kind={v.kind}
      className={`mb-3 block rounded-md border p-3 ${KIND_BOX[v.kind]}`}
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <span
          className={`font-sans text-sm font-semibold ${KIND_HEADLINE[v.kind]}`}
        >
          {v.headline}
        </span>
        <span className="text-secondary font-mono text-[10px]">
          Δ: {v.delta} · V: {v.vega}
        </span>
      </div>
      <p className="text-primary mt-1 font-sans text-xs">{v.action}</p>
    </output>
  );
}

export const VerdictTile = memo(VerdictTileInner);

interface VerdictTimelineProps {
  spyRows: readonly GreekFlowRow[];
  qqqRows: readonly GreekFlowRow[];
}

function VerdictTimelineInner({ spyRows, qqqRows }: VerdictTimelineProps) {
  const summary = computeVerdictTimeline(spyRows, qqqRows);
  if (summary.points.length < 2) return null;

  const last = summary.points.at(-1);
  const currentKind = last?.kind ?? 'no-trade';

  return (
    <div className="mb-3" data-testid="greek-flow-timeline">
      <div
        role="img"
        aria-label="Verdict timeline through the session"
        className="border-edge bg-surface flex h-3 overflow-hidden rounded border"
      >
        {summary.points.map((p) => (
          <span
            key={p.timestamp}
            title={`${fmtTime(p.timestamp)} — ${KIND_LABEL[p.kind]}`}
            className={`h-full ${KIND_BAR[p.kind]}`}
            style={{ width: `${100 / summary.points.length}%` }}
          />
        ))}
      </div>
      <div className="text-secondary mt-1 flex flex-wrap gap-x-3 font-mono text-[10px]">
        <span>
          Now: <span className="text-primary">{KIND_LABEL[currentKind]}</span>
          {summary.currentSince
            ? ` since ${fmtTime(summary.currentSince)}`
            : ''}
        </span>
        <span>
          Transitions:{' '}
          <span className="text-primary">{summary.transitions}</span>
        </span>
      </div>
    </div>
  );
}

export const VerdictTimeline = memo(VerdictTimelineInner);

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}
