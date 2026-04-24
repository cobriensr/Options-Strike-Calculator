import { useEffect, useState } from 'react';
import type { ActiveAnomaly, IVAnomalyFlowPhase } from './types';
import { StrikeIVChart } from './StrikeIVChart';

/**
 * Per-active-strike row. Each row represents ONE compound key
 * (`ticker:strike:side:expiry`) that the detector is currently firing on.
 * Metrics come from `anomaly.latest` and update in-place as new rows
 * arrive from the hook's aggregation layer. Row also surfaces
 * aggregation-level telemetry — active duration, firing count, and
 * freshness — so the user can see intensity at a glance.
 *
 * Collapsed by default; expands to a full detail drawer with the
 * `context_snapshot` fields + per-strike IV mini-chart when clicked.
 */
export function AnomalyRow({ anomaly }: { readonly anomaly: ActiveAnomaly }) {
  const [expanded, setExpanded] = useState(false);
  const latest = anomaly.latest;
  const phase = latest.flowPhase;

  // Track `now` as state so the "active 42m" / "last fire 2m ago" labels
  // roll forward even when no new row has arrived. Refreshed every 30s;
  // that's tight enough for at-a-glance reading without thrashing.
  // Storing it as state (rather than calling Date.now() in render) keeps
  // the component pure per react-hooks/purity.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // SPX-only: the spec flagged that spx_recent_dark_prints is SPX-scoped.
  // Hide the "dark prints" sub-field for SPY / QQQ entirely so we never
  // mis-attribute an SPX print to a different underlying.
  const isSpxScoped = anomaly.ticker === 'SPX';

  const activeDurationLabel = formatDuration(
    nowMs - Date.parse(anomaly.firstSeenTs),
  );
  const freshnessLabel = formatFreshness(
    nowMs - Date.parse(anomaly.lastFiredTs),
  );

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
          {latest.flagReasons.map((reason) => (
            <FlagBadge key={reason} reason={reason} />
          ))}
          <span className="text-muted ml-2 font-mono text-[10px]">
            active {activeDurationLabel}
          </span>
          <span className="text-muted font-mono text-[10px]">
            last fire {freshnessLabel}
          </span>
          <span className="text-muted font-mono text-[10px]">
            firings: {anomaly.firingCount}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-edge border-t px-3 py-3">
          <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-4">
            <Metric
              label="spot @ detect"
              value={latest.spotAtDetect.toFixed(2)}
            />
            <Metric
              label="IV @ detect"
              value={`${(latest.ivAtDetect * 100).toFixed(1)}%`}
            />
            <Metric
              label="skew Δ"
              value={fmtOrDash(latest.skewDelta, (v) => v.toFixed(2))}
            />
            <Metric
              label="Z-score"
              value={fmtOrDash(latest.zScore, (v) => v.toFixed(2))}
            />
            <Metric
              label="ask-mid Δ"
              value={fmtOrDash(latest.askMidDiv, (v) => v.toFixed(3))}
            />
          </div>

          <ContextSnapshotView
            snapshot={latest.contextSnapshot}
            isSpxScoped={isSpxScoped}
          />

          <ResolutionOutcomeView outcome={latest.resolutionOutcome} />

          <div className="mt-4">
            <StrikeIVChart
              ticker={anomaly.ticker}
              strike={anomaly.strike}
              side={anomaly.side}
              expiry={anomaly.expiry}
              detectedAt={latest.ts}
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

type OutcomeClass = 'winner_fast' | 'winner_slow' | 'flat' | 'loser';

interface ParsedResolution {
  outcomeClass: OutcomeClass | null;
  notional1cPnl: number | null;
  ivAtDetect: number | null;
  ivAtClose: number | null;
  minsToPeak: number | null;
  likelyCatalyst: string | null;
  topLeadingAssets: Array<{
    ticker: string;
    correlation: number;
    lagMins: number;
  }>;
}

function isValidOutcomeClass(v: unknown): v is OutcomeClass {
  return (
    v === 'winner_fast' || v === 'winner_slow' || v === 'flat' || v === 'loser'
  );
}

function parseResolution(raw: unknown): ParsedResolution | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const outcomeClass = isValidOutcomeClass(r.outcome_class)
    ? r.outcome_class
    : null;
  const notional1cPnl =
    typeof r.notional_1c_pnl === 'number' && Number.isFinite(r.notional_1c_pnl)
      ? r.notional_1c_pnl
      : null;
  const ivAtDetect =
    typeof r.iv_at_detect === 'number' && Number.isFinite(r.iv_at_detect)
      ? r.iv_at_detect
      : null;
  const ivAtClose =
    typeof r.iv_at_close === 'number' && Number.isFinite(r.iv_at_close)
      ? r.iv_at_close
      : null;
  const minsToPeak =
    typeof r.mins_to_peak === 'number' && Number.isFinite(r.mins_to_peak)
      ? r.mins_to_peak
      : null;

  const catalysts =
    r.catalysts && typeof r.catalysts === 'object'
      ? (r.catalysts as Record<string, unknown>)
      : null;
  const likelyCatalyst =
    typeof catalysts?.likely_catalyst === 'string'
      ? catalysts.likely_catalyst
      : null;

  const leadingAssetsRaw = Array.isArray(catalysts?.leading_assets)
    ? catalysts.leading_assets
    : [];
  const topLeadingAssets = leadingAssetsRaw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      ticker: typeof x.ticker === 'string' ? x.ticker : '',
      correlation:
        typeof x.correlation === 'number' && Number.isFinite(x.correlation)
          ? x.correlation
          : 0,
      lagMins:
        typeof x.lag_mins === 'number' && Number.isFinite(x.lag_mins)
          ? x.lag_mins
          : 0,
    }))
    .filter((x) => x.ticker !== '')
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
    .slice(0, 3);

  // Treat an otherwise-empty resolution object (no outcome_class, no P&L,
  // no catalyst narrative) as "not yet resolved" — render nothing.
  if (outcomeClass == null && notional1cPnl == null && likelyCatalyst == null) {
    return null;
  }

  return {
    outcomeClass,
    notional1cPnl,
    ivAtDetect,
    ivAtClose,
    minsToPeak,
    likelyCatalyst,
    topLeadingAssets,
  };
}

function OutcomePill({
  outcomeClass,
}: {
  readonly outcomeClass: OutcomeClass;
}) {
  const classes: Record<OutcomeClass, string> = {
    winner_fast: 'bg-green-500/20 text-green-300',
    winner_slow: 'bg-emerald-500/20 text-emerald-300',
    flat: 'bg-slate-500/20 text-slate-300',
    loser: 'bg-rose-500/20 text-rose-300',
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${classes[outcomeClass]}`}
    >
      {outcomeClass}
    </span>
  );
}

function formatPnl(v: number): string {
  const sign = v >= 0 ? '+' : '−';
  const abs = Math.abs(v);
  return `${sign}$${abs.toFixed(0)}`;
}

function ResolutionOutcomeView({ outcome }: { readonly outcome: unknown }) {
  const parsed = parseResolution(outcome);
  // Not yet resolved (EOD cron hasn't scored this anomaly yet) → hide.
  if (!parsed) return null;

  const ivDelta =
    parsed.ivAtDetect != null && parsed.ivAtClose != null
      ? parsed.ivAtClose - parsed.ivAtDetect
      : null;
  const ivDeltaLabel =
    ivDelta != null
      ? ` (${ivDelta >= 0 ? '+' : ''}${(ivDelta * 100).toFixed(1)}pt)`
      : '';
  const ivDetectPct =
    parsed.ivAtDetect != null ? (parsed.ivAtDetect * 100).toFixed(1) : '';
  const ivClosePct =
    parsed.ivAtClose != null ? (parsed.ivAtClose * 100).toFixed(1) : '';
  const ivDetectToCloseLabel = `${ivDetectPct}% → ${ivClosePct}%${ivDeltaLabel}`;

  return (
    <section
      aria-label="End-of-day resolution"
      className="border-edge mt-4 border-t pt-3"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted text-[11px] font-semibold tracking-wide uppercase">
          Resolution (EOD)
        </span>
        {parsed.outcomeClass && (
          <OutcomePill outcomeClass={parsed.outcomeClass} />
        )}
      </div>

      <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-4">
        {parsed.notional1cPnl != null && (
          <Metric
            label="1-contract P&L"
            value={formatPnl(parsed.notional1cPnl)}
          />
        )}
        {parsed.ivAtDetect != null && parsed.ivAtClose != null && (
          <Metric label="IV detect → close" value={ivDetectToCloseLabel} />
        )}
        {parsed.minsToPeak != null && (
          <Metric label="mins to peak" value={parsed.minsToPeak.toFixed(0)} />
        )}
      </div>

      {parsed.likelyCatalyst && (
        <p className="text-primary mb-2 text-[11px] italic">
          {parsed.likelyCatalyst}
        </p>
      )}

      {parsed.topLeadingAssets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <span className="text-muted font-mono uppercase">leading:</span>
          {parsed.topLeadingAssets.map((a) => (
            <span
              key={a.ticker}
              className="bg-surface border-edge rounded border px-1.5 py-0.5 font-mono"
            >
              <span className="text-primary">{a.ticker}</span>
              <span className="text-muted">
                {' '}
                ρ={a.correlation.toFixed(2)} lag={a.lagMins}m
              </span>
            </span>
          ))}
        </div>
      )}
    </section>
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

/**
 * "42m active" / "2h 15m active" / "just started". The duration label
 * intentionally reads like prose because it's glanced at, not parsed.
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just started';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return 'just started';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * "just now" / "2m ago" / "14m ago". Used for the "last fire" label — a
 * scan cue for whether the strike is still hot.
 */
function formatFreshness(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m ago`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m ago`;
}
