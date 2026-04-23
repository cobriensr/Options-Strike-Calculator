import { useState } from 'react';
import type {
  IVAnomalyFlowPhase,
  IVAnomalyRow as IVAnomalyRowData,
} from './types';
import { StrikeIVChart } from './StrikeIVChart';

/**
 * Per-anomaly row. Compact by default; expands to a full detail drawer
 * with the `context_snapshot` fields + per-strike IV mini-chart when
 * clicked. Shows a flow-phase pill, the target strike, flag reasons, and
 * the detection metrics.
 */
export function AnomalyRow({
  anomaly,
}: {
  readonly anomaly: IVAnomalyRowData;
}) {
  const [expanded, setExpanded] = useState(false);
  const phase = anomaly.flowPhase;

  // Format the detection timestamp in the user's local tz but drop seconds
  // for density. `Intl.DateTimeFormat` handles an ISO string cleanly.
  const tsLabel = formatTs(anomaly.ts);

  // SPX-only: the spec flagged that spx_recent_dark_prints is SPX-scoped.
  // Hide the "dark prints" sub-field for SPY / QQQ entirely so we never
  // mis-attribute an SPX print to a different underlying.
  const isSpxScoped = anomaly.ticker === 'SPX';

  return (
    <div className="border-edge bg-surface-alt rounded-md border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`Toggle details for ${anomaly.ticker} ${anomaly.strike} ${anomaly.side} anomaly`}
        className="hover:bg-surface flex w-full items-center gap-3 px-3 py-2 text-left transition-colors"
      >
        <span className="text-muted font-mono text-[10px]">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="text-primary font-mono text-xs font-semibold">
          {anomaly.ticker} {formatStrike(anomaly.strike)}
          {anomaly.side === 'put' ? 'P' : 'C'}
        </span>
        <span className="text-muted font-mono text-[10px]">
          exp {anomaly.expiry}
        </span>
        <PhasePill phase={phase} />
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {anomaly.flagReasons.map((reason) => (
            <FlagBadge key={reason} reason={reason} />
          ))}
          <span className="text-muted ml-2 font-mono text-[10px]">
            {tsLabel}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-edge border-t px-3 py-3">
          <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-4">
            <Metric
              label="spot @ detect"
              value={anomaly.spotAtDetect.toFixed(2)}
            />
            <Metric
              label="IV @ detect"
              value={`${(anomaly.ivAtDetect * 100).toFixed(1)}%`}
            />
            <Metric
              label="skew Δ"
              value={fmtOrDash(anomaly.skewDelta, (v) => v.toFixed(2))}
            />
            <Metric
              label="Z-score"
              value={fmtOrDash(anomaly.zScore, (v) => v.toFixed(2))}
            />
            <Metric
              label="ask-mid Δ"
              value={fmtOrDash(anomaly.askMidDiv, (v) => v.toFixed(3))}
            />
          </div>

          <ContextSnapshotView
            snapshot={anomaly.contextSnapshot}
            isSpxScoped={isSpxScoped}
          />

          <div className="mt-4">
            <StrikeIVChart
              ticker={anomaly.ticker as 'SPX' | 'SPY' | 'QQQ'}
              strike={anomaly.strike}
              side={anomaly.side}
              expiry={anomaly.expiry}
              detectedAt={anomaly.ts}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────

function PhasePill({ phase }: { readonly phase: IVAnomalyFlowPhase | null }) {
  if (!phase) {
    return (
      <span className="rounded-full bg-slate-700/40 px-2 py-0.5 font-mono text-[10px] font-semibold text-slate-300">
        unclassified
      </span>
    );
  }
  const classes: Record<IVAnomalyFlowPhase, string> = {
    early: 'bg-emerald-500/20 text-emerald-300',
    mid: 'bg-amber-500/20 text-amber-300',
    reactive: 'bg-rose-500/20 text-rose-300',
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${classes[phase]}`}
    >
      {phase}
    </span>
  );
}

function FlagBadge({ reason }: { readonly reason: string }) {
  return (
    <span className="bg-accent-bg text-accent rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold">
      {reason}
    </span>
  );
}

function Metric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-muted text-[10px]">{label}</span>
      <span className="text-primary">{value}</span>
    </div>
  );
}

function ContextSnapshotView({
  snapshot,
  isSpxScoped,
}: {
  readonly snapshot: unknown;
  readonly isSpxScoped: boolean;
}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return (
      <div className="text-muted text-[11px] italic">
        No context snapshot captured.
      </div>
    );
  }

  // Reveal a curated subset of the ~35 context fields as the default view —
  // the common "what was the tape doing" flight panel — plus a collapsible
  // raw JSON pane for deep dives.
  const entries = Object.entries(snapshot as Record<string, unknown>);
  const highlights = entries.filter(([k]) =>
    [
      'spot_delta_15m',
      'vix_level',
      'vix_delta_15m',
      'nq_delta_15m',
      'es_delta_15m',
      'zero_gamma_distance_pct',
      'nope_current',
      'put_premium_0dte_pctile',
      'econ_release_t_minus',
      'econ_release_t_plus',
      'econ_release_name',
    ].includes(k),
  );

  return (
    <details className="text-[11px]">
      <summary className="text-muted cursor-pointer select-none">
        Context snapshot ({entries.length} fields)
      </summary>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono sm:grid-cols-3">
        {highlights.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <span className="text-muted text-[10px]">{k}</span>
            <span className="text-primary">{formatContextValue(v)}</span>
          </div>
        ))}
      </div>
      {!isSpxScoped && (
        <p className="text-muted mt-2 text-[10px] italic">
          Dark prints omitted — the ingestion pipeline is SPX-scoped.
        </p>
      )}
      <pre className="bg-surface border-edge mt-3 max-h-56 overflow-auto rounded border p-2 font-mono text-[10px] leading-tight text-slate-300">
        {JSON.stringify(snapshot, null, 2)}
      </pre>
    </details>
  );
}

// ── Pure helpers ────────────────────────────────────────────────

function formatStrike(n: number): string {
  // SPX strikes are 5-wide integers; SPY/QQQ are fractional. Avoid trailing
  // zeros for SPX to keep the row compact.
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function fmtOrDash(value: number | null, fmt: (v: number) => string): string {
  return value == null ? '—' : fmt(value);
}

function formatContextValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '—';
    return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3);
  }
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `[${v.length} items]`;
  return typeof v === 'object' ? '{…}' : String(v);
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return iso;
  }
}
