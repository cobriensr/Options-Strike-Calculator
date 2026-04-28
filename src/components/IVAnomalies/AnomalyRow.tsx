import { useEffect, useState } from 'react';
import type {
  ActiveAnomaly,
  AnomalyCrossAssetContext,
  AnomalyPattern,
  AnomalyRegime,
  DPCluster,
  GEXZone,
  IVAnomalyFlowPhase,
  IVAnomalyPhase,
  IVAnomalySide,
  IVAnomalySideDominant,
  TapeAlignment,
  VIXDirection,
} from './types';
import { derivePattern } from './types';
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
export function AnomalyRow({
  anomaly,
  crossAsset,
}: {
  readonly anomaly: ActiveAnomaly;
  readonly crossAsset?: AnomalyCrossAssetContext;
}) {
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

  // SPX-scoped: `spx_recent_dark_prints` only populates for tickers that
  // share the SPX cash feed — post 2026-04-24 rescope that's SPXW only.
  // For SPY / QQQ / IWM / NDXP we never attribute SPX prints, so the
  // sub-field stays hidden to avoid misread.
  const isSpxScoped = anomaly.ticker === 'SPXW';

  const activeDurationMs = nowMs - Date.parse(anomaly.firstSeenTs);
  const activeDurationLabel = formatDuration(activeDurationMs);
  const freshnessLabel = formatFreshness(
    nowMs - Date.parse(anomaly.lastFiredTs),
  );
  const exitSubtitle = buildExitSubtitle(anomaly);
  const pattern = derivePattern(activeDurationMs, anomaly.firingCount);

  const occSymbol = buildOccSymbol(
    anomaly.ticker,
    anomaly.expiry,
    anomaly.side,
    anomaly.strike,
  );
  const contractLabel = `${anomaly.ticker} ${formatStrike(anomaly.strike)}${anomaly.side === 'put' ? 'P' : 'C'}`;
  const toggle = () => setExpanded((v) => !v);

  return (
    <div className="border-edge bg-surface-alt rounded-md border">
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        aria-expanded={expanded}
        aria-label={`Toggle details for ${anomaly.ticker} ${anomaly.strike} ${anomaly.side} anomaly`}
        className="hover:bg-surface flex w-full cursor-pointer flex-col gap-1 px-3 py-2 text-left transition-colors"
      >
        <div className="flex w-full items-center gap-3">
          <span className="text-muted font-mono text-[10px]">
            {expanded ? '▾' : '▸'}
          </span>
          {occSymbol ? (
            <a
              href={`https://unusualwhales.com/option-chain/${encodeURIComponent(occSymbol)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-primary font-mono text-xs font-semibold hover:underline"
              title={`View ${occSymbol} on Unusual Whales`}
              aria-label={`Open ${contractLabel} on Unusual Whales (opens in new tab)`}
            >
              {contractLabel}
            </a>
          ) : (
            <span className="text-primary font-mono text-xs font-semibold">
              {contractLabel}
            </span>
          )}
          <VolOiPill ratio={latest.volOiRatio} />
          <SideSkewPill
            sideDominant={latest.sideDominant}
            sideSkew={latest.sideSkew}
            bidPct={latest.bidPct}
            askPct={latest.askPct}
            totalVolAtDetect={latest.totalVolAtDetect}
          />
          <span className="text-muted font-mono text-[10px]">
            exp {anomaly.expiry}
          </span>
          <AnomalyPhasePill phase={anomaly.phase} />
          <FlowPhasePill phase={phase} />
          <PatternPill pattern={pattern} />
          <RegimePill
            regime={crossAsset?.regime ?? 'unknown'}
            side={anomaly.side}
          />
          <TapeAlignPill alignment={crossAsset?.tapeAlignment ?? 'missing'} />
          <DPClusterPill cluster={crossAsset?.dpCluster ?? 'na'} />
          <GEXZonePill zone={crossAsset?.gexZone ?? 'na'} side={anomaly.side} />
          <VIXDirPill direction={crossAsset?.vixDirection ?? 'unknown'} />
          <div className="ml-auto flex flex-wrap items-center gap-1">
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
        </div>
        {/* Flag badges live on a second row below so the new cross-asset pills
            don't push them off-screen on narrow viewports (per Phase F UI spec). */}
        {latest.flagReasons.length > 0 && (
          <div className="ml-5 flex flex-wrap items-center gap-1">
            {latest.flagReasons.map((reason) => (
              <FlagBadge key={reason} reason={reason} />
            ))}
          </div>
        )}
        {exitSubtitle && (
          <div className="ml-5 text-[10px] text-amber-300/80 italic">
            {exitSubtitle}
          </div>
        )}
      </div>

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
              label="vol/OI"
              value={fmtOrDash(latest.volOiRatio, formatVolOi)}
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

/**
 * Prominent vol/OI pill. The user treats this as the PRIMARY signal —
 * the 5× gate is what made the detector useful. Color intensifies at
 * progressively more-saturated ratios so a glance tells you whether
 * it's "just cleared" (5-10×) vs "massive" (50×+).
 *
 * Null ratio (legacy pre-migration row) renders nothing — the pill slot
 * is optional, not a required header field.
 */
function VolOiPill({ ratio }: { readonly ratio: number | null }) {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  let tier: string;
  if (ratio >= 50) {
    tier = 'bg-fuchsia-500/30 text-fuchsia-200';
  } else if (ratio >= 20) {
    tier = 'bg-rose-500/25 text-rose-200';
  } else if (ratio >= 10) {
    tier = 'bg-orange-500/25 text-orange-200';
  } else {
    tier = 'bg-amber-500/20 text-amber-200';
  }
  return (
    <span
      className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-bold ${tier}`}
      data-testid="vol-oi-pill"
      title="cumulative intraday volume / start-of-day open interest"
    >
      vol/OI {formatVolOi(ratio)}
    </span>
  );
}

function formatVolOi(ratio: number): string {
  // Truncate to a single decimal if < 10, else round to whole. 5.3× vs
  // 52× are both what the user glances for; trailing zeros just add noise.
  if (ratio < 10) return `${ratio.toFixed(1)}×`;
  return `${Math.round(ratio)}×`;
}

/** Compact volume formatter for tape-side surge subtitles: 6300 → "6.3K", 12500 → "12.5K". */
function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * Side-dominance pill — fraction of the strike's cumulative-since-open
 * tape volume that printed on the dominant side. Real bid/ask volume from
 * `strike_trade_volume` (UW flow-per-strike-intraday) on post-migration-95
 * rows; falls back to the legacy IV-spread proxy on pre-migration-95 rows
 * via `sideSkew` / `sideDominant`.
 *
 * Renders `ASK 88%` (buyers lifting offer) or `BID 71%` (sellers hitting
 * bid) on a colored chip. Tooltip shows exact volume + total trades.
 * Mixed flow (neither side ≥ 65%) doesn't render — those rows don't fire
 * anyway given the gate.
 *
 * Legacy rows pre-migration 86 have null `sideSkew` / `sideDominant`;
 * render nothing in that case.
 */
function SideSkewPill({
  sideDominant,
  sideSkew,
  bidPct,
  askPct,
  totalVolAtDetect,
}: {
  readonly sideDominant: IVAnomalySideDominant | null;
  readonly sideSkew: number | null;
  readonly bidPct: number | null;
  readonly askPct: number | null;
  readonly totalVolAtDetect: number | null;
}) {
  if (
    sideDominant == null ||
    sideDominant === 'mixed' ||
    sideSkew == null ||
    !Number.isFinite(sideSkew)
  ) {
    return null;
  }
  // Ask-dominant = buyers lifting the offer (accumulation) → amber.
  // Bid-dominant = sellers hitting the bid (distribution) → cyan.
  const tier =
    sideDominant === 'ask'
      ? 'bg-amber-500/25 text-amber-200'
      : 'bg-cyan-500/25 text-cyan-200';
  const label = sideDominant.toUpperCase();
  // Prefer the explicit per-side pct when available (real tape, post-migration 95);
  // fall back to sideSkew (legacy proxy or rounded max) for older rows.
  const explicitPct =
    sideDominant === 'ask' ? askPct : sideDominant === 'bid' ? bidPct : null;
  const pctSource =
    explicitPct != null && Number.isFinite(explicitPct)
      ? explicitPct
      : sideSkew;
  const pct = Math.round(pctSource * 100);
  const hasRealTape =
    explicitPct != null &&
    Number.isFinite(explicitPct) &&
    totalVolAtDetect != null &&
    Number.isFinite(totalVolAtDetect);
  const title = hasRealTape
    ? `${pct}% of ${formatVolume(totalVolAtDetect!)} cumulative volume printed at the ${sideDominant} today`
    : `Legacy IV-spread proxy: ${label} side carries ${pct}% of the bid-ask IV spread`;
  return (
    <span
      className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-bold ${tier}`}
      data-testid="side-skew-pill"
      title={title}
    >
      {label} {pct}%
    </span>
  );
}

/** Display pill for the exit-signal phase (active | cooling | distributing). */
function AnomalyPhasePill({ phase }: { readonly phase: IVAnomalyPhase }) {
  const classes: Record<IVAnomalyPhase, string> = {
    active: 'bg-rose-500/20 text-rose-300',
    cooling: 'bg-amber-500/20 text-amber-300',
    distributing: 'bg-orange-600/30 text-orange-300',
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${classes[phase]}`}
      data-testid={`anomaly-phase-${phase}`}
    >
      {phase}
    </span>
  );
}

/**
 * Detector firing pattern pill — surfaces Phase D4 finding that flash
 * alerts (single firing, <5 min duration) outperform persistent alerts
 * (≥20 firings or ≥60 min duration) by 2× on the call side. Pure visual
 * cue; no entry/exit logic depends on it. `derivePattern` lives in
 * types.ts so this file only exports components.
 */
function PatternPill({ pattern }: { readonly pattern: AnomalyPattern }) {
  const classes: Record<AnomalyPattern, string> = {
    flash: 'bg-sky-500/20 text-sky-300',
    medium: 'bg-slate-500/20 text-slate-300',
    persistent: 'bg-zinc-500/20 text-zinc-400',
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${classes[pattern]}`}
      data-testid={`anomaly-pattern-${pattern}`}
      title={
        pattern === 'flash'
          ? 'Flash: <5 min, <3 firings — empirically best win rate (Phase D4).'
          : pattern === 'persistent'
            ? 'Persistent: ≥60 min or ≥20 firings — empirically lower win rate.'
            : 'Medium: between flash and persistent.'
      }
    >
      {pattern}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Cross-asset confluence pills (Phase F)
//
// Five pills surfacing Phase D + Phase E findings as visual cues only.
// Strictly visual — none of these gates entry/exit. The trader reads
// them and makes their own call. Side-aware coloring (RegimePill,
// GEXZonePill) mirrors the alert direction so a green pill always
// means "confluent with this alert," not "the market is up."
// ────────────────────────────────────────────────────────────────────────

const PILL_BASE =
  'rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold';
const PILL_GREEN = 'bg-emerald-500/20 text-emerald-300';
const PILL_RED = 'bg-rose-500/20 text-rose-300';
const PILL_GRAY = 'bg-slate-500/20 text-slate-300';
const PILL_SKY = 'bg-sky-500/20 text-sky-300';
const PILL_DIM = 'bg-zinc-500/15 text-zinc-500';

function regimeColor(regime: AnomalyRegime, side: IVAnomalySide): string {
  if (regime === 'unknown') return PILL_DIM;
  if (regime === 'chop') return PILL_GRAY;
  const isUp = regime.endsWith('_up');
  const wantUp = side === 'call';
  return isUp === wantUp ? PILL_GREEN : PILL_RED;
}

function RegimePill({
  regime,
  side,
}: {
  readonly regime: AnomalyRegime;
  readonly side: IVAnomalySide;
}) {
  return (
    <span
      className={`${PILL_BASE} ${regimeColor(regime, side)}`}
      data-testid={`anomaly-regime-${regime}`}
      title="Underlying's same-day % change vs alert direction (Phase D0 regime spine). Green = trend supports the alert side; red = trend against."
    >
      {regime}
    </span>
  );
}

function tapeColor(alignment: TapeAlignment): string {
  if (alignment === 'aligned') return PILL_GREEN;
  if (alignment === 'contradicted') return PILL_RED;
  return PILL_GRAY;
}

function TapeAlignPill({ alignment }: { readonly alignment: TapeAlignment }) {
  return (
    <span
      className={`${PILL_BASE} ${tapeColor(alignment)}`}
      data-testid={`anomaly-tape-${alignment}`}
      title="NQ/ES/RTY/SPX direction over last 15 min vs alert side (Phase E1). Edge is small post-correction: +2pt on mild_trend_up days, but inverts −8pt on chop days (contradicted outperforms aligned)."
    >
      tape: {alignment}
    </span>
  );
}

function dpColor(cluster: DPCluster): string {
  if (cluster === 'large') return PILL_SKY;
  if (cluster === 'medium') return PILL_SKY;
  return PILL_DIM;
}

function DPClusterPill({ cluster }: { readonly cluster: DPCluster }) {
  const tooltip =
    cluster === 'large'
      ? 'Dark-pool premium >$200M at this strike (Phase E2). On mild-trend-up days SPXW calls with DP confluence won 91.7% (n=36, tentative — sample-period bias possible).'
      : cluster === 'medium'
        ? 'Dark-pool premium $50-200M at this strike. Phase E2 saw 71.4% win rate on mild-trend-up SPXW calls (n=42).'
        : cluster === 'small'
          ? 'Small dark-pool premium (<$50M) at strike. No directional edge.'
          : cluster === 'na'
            ? 'Dark-pool data only attributed for SPXW alerts in this dataset.'
            : 'No dark-pool premium clustered at this strike.';
  return (
    <span
      className={`${PILL_BASE} ${dpColor(cluster)}`}
      data-testid={`anomaly-dp-${cluster}`}
      title={tooltip}
    >
      DP: {cluster}
    </span>
  );
}

function gexColor(zone: GEXZone, side: IVAnomalySide): string {
  if (zone === 'na' || zone === 'at_spot') return PILL_GRAY;
  // E4: calls do better when nearest top-3 GEX is BELOW spot (support
  // zone, room to run). Puts mirror.
  const wantBelow = side === 'call';
  const isBelow = zone === 'below_spot';
  return isBelow === wantBelow ? PILL_GREEN : PILL_RED;
}

function GEXZonePill({
  zone,
  side,
}: {
  readonly zone: GEXZone;
  readonly side: IVAnomalySide;
}) {
  return (
    <span
      className={`${PILL_BASE} ${gexColor(zone, side)}`}
      data-testid={`anomaly-gex-${zone}`}
      title="Nearest top-3 abs_gex strike vs current spot (Phase E4). On mild_trend_up days, calls win 68.7% with GEX below spot (n=195) vs 39.7% above (n=827); puts mirror."
    >
      GEX: {zone}
    </span>
  );
}

function vixColor(direction: VIXDirection): string {
  if (direction === 'falling') return PILL_GREEN;
  if (direction === 'rising') return PILL_RED;
  return PILL_GRAY;
}

function VIXDirPill({ direction }: { readonly direction: VIXDirection }) {
  return (
    <span
      className={`${PILL_BASE} ${vixColor(direction)}`}
      data-testid={`anomaly-vix-${direction}`}
      title="VIX 30-min change at alert (Phase E3). Chop + falling VIX + put is the only put-side cell with positive mean dollar (27.7% win, +$66 mean, n=137)."
    >
      VIX: {direction}
    </span>
  );
}

/** Display pill for the detector's early/mid/reactive flow classification. */
function FlowPhasePill({
  phase,
}: {
  readonly phase: IVAnomalyFlowPhase | null;
}) {
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

/**
 * Build a human-readable "why" subtitle for cooling / distributing phases.
 * Returns null while active — no subtitle shown in the default case.
 */
function buildExitSubtitle(anomaly: ActiveAnomaly): string | null {
  if (anomaly.phase === 'active') return null;
  if (anomaly.phase === 'distributing') {
    // Show concrete bid-side vs ask-side numbers when tape data is present.
    if (anomaly.accumulatedAskSideVol > 0) {
      const windowStart = Date.now() - 15 * 60 * 1000;
      let bidInWindow = 0;
      for (const p of anomaly.tapeVolumeHistory) {
        if (Date.parse(p.ts) >= windowStart) bidInWindow += p.bidSideVol;
      }
      const pct = Math.round(
        (bidInWindow / anomaly.accumulatedAskSideVol) * 100,
      );
      return `Bid-side surge: ${formatVolume(bidInWindow)} in 15min vs ${formatVolume(anomaly.accumulatedAskSideVol)} ask-side accumulated (${pct}%)`;
    }
    return 'Bid-side volume surge — distribution';
  }
  // Cooling — differentiate by reason.
  if (anomaly.exitReason === 'iv_regression') {
    const peakPct = (anomaly.peakIv * 100).toFixed(1);
    const currPct = (anomaly.latest.ivAtDetect * 100).toFixed(1);
    const range = anomaly.peakIv - anomaly.entryIv;
    if (range > 0) {
      const dropPct = Math.round(
        ((anomaly.peakIv - anomaly.latest.ivAtDetect) / range) * 100,
      );
      return `IV down ${dropPct}% from peak (${peakPct}vp → ${currPct}vp)`;
    }
    return `IV down from peak (${peakPct}vp → ${currPct}vp)`;
  }
  if (anomaly.exitReason === 'ask_mid_compression') {
    return 'Ask-mid spread compressing (MMs disengaging)';
  }
  return 'Exit signal active';
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

/**
 * Build an OCC option symbol so the contract ID can deep-link into the
 * Unusual Whales option-chain page (`unusualwhales.com/option-chain/{OCC}`).
 *
 * Format: ROOT + YYMMDD + (C|P) + STRIKE×1000 zero-padded to 8 digits.
 * Strike is in *mills*, not dollars, so SPY 712 → "00712000".
 *
 * Returns null on a malformed expiry so the caller can fall back to plain
 * text rather than render a broken URL.
 */
function buildOccSymbol(
  ticker: string,
  expiry: string,
  side: IVAnomalySide,
  strike: number,
): string | null {
  const m = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const yy = m[1]!.slice(2);
  const mm = m[2]!;
  const dd = m[3]!;
  const sideChar = side === 'call' ? 'C' : 'P';
  const strikeMills = Math.round(strike * 1000);
  if (!Number.isFinite(strikeMills) || strikeMills <= 0) return null;
  return `${ticker}${yy}${mm}${dd}${sideChar}${strikeMills.toString().padStart(8, '0')}`;
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
