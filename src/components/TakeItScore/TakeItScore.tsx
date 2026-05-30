/**
 * Take-It Score tile.
 *
 * Spec: docs/superpowers/specs/alert-takeit-score-2026-05-16.md
 *       Phase 4 = render the bundle prob + SHAP top-K flags on each row.
 *
 * Decision #6 colour bands (from the spec):
 *    < 0.40    red          take with caution
 *    0.40–0.55 amber        coin-flip
 *    0.55–0.70 green        decent
 *    > 0.70    deep green   strong
 *
 * Two visual modes:
 *   - default       prob chip + optional info dot when flags are available
 *   - expanded      same chip + a compact inline list of green/red flag
 *                   names. Triggered by the parent row toggle (not built
 *                   yet — Phase 4.5 adds the expand-on-click affordance).
 *
 * `takeitTopFeatures` is the JSONB column the SHAP fill cron writes ~2 min
 * after the alert fires. Until then it's `null` and we render a small
 * "loading flags" indicator next to the prob — but only when the cron is
 * expected to populate (i.e. takeitProb is not null).
 */

import { memo } from 'react';

import { takeitProbClass } from './takeit-prob-class.js';

/** Top-K SHAP contribution as emitted by sidecar /takeit/explain. */
interface ShapContribution {
  name: string;
  shap_value: number;
  feature_value: unknown;
}

interface TakeitTopFeatures {
  positive: ShapContribution[];
  negative: ShapContribution[];
}

export interface TakeItScoreProps {
  prob: number | null | undefined;
  topFeatures: Record<string, unknown> | null | undefined;
  /** Compact mode shrinks the chip to a 24px-tall pill — for dense rows. */
  compact?: boolean;
  /** Expanded mode appends an inline flag list. */
  expanded?: boolean;
  /**
   * Chain-level PEAK Take-It probability (MAX over all fires in the
   * chain). When this is meaningfully above the displayed `prob`, the
   * chain qualified for the feed on an earlier, hotter fire but the
   * latest fire has cooled off — we badge "peak 0.XX @ HH:MM" so the
   * trader sees why a now-cooler chain is still on the list (the feed
   * gates on the peak, not the latest fire — spec
   * lottery-no-vanish-2026-05-29.md).
   */
  peakProb?: number | null;
  /** ISO timestamp of the fire that hit `peakProb`. */
  peakAt?: string | null;
}

/** Human-readable two-decimal probability or "—" when missing. */
function formatProb(prob: number | null | undefined): string {
  if (prob == null || Number.isNaN(prob)) return '—';
  return prob.toFixed(2);
}

/** HH:MM in Central Time, or '' when the timestamp is missing/invalid. */
function formatPeakTimeCt(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });
}

/**
 * Map raw feature_name → trader-friendly label. Falls back to the underlying
 * name when unmapped so a new feature shipping in a retrain still renders.
 */
function featureLabel(rawName: string): string {
  const map: Record<string, string> = {
    session_phase: 'Time of day',
    minute_of_day_ct: 'Minute of day',
    day_of_week: 'Day of week',
    dte: 'DTE',
    is_itm_at_fire: 'ITM at fire',
    otm_distance_pct: 'OTM distance',
    dealer_gamma_sign: 'Dealer γ regime',
    aggressive_premium_flag: 'Aggressive premium',
    burst_storm_badge: 'Burst storm',
    burst_storm_distinct_count: 'Burst-storm count',
    silent_boom_cofire_within_5min: 'Silent Boom co-fire',
    silent_boom_cofire_diff_chain_within_5min:
      'Silent Boom co-fire (sibling chain)',
    lottery_cofire_within_5min: 'Lottery co-fire',
    lottery_cofire_diff_chain_within_5min: 'Lottery co-fire (sibling chain)',
    n_same_dir_fires_last_30min: 'Same-dir recent fires',
    prior_session_win_rate_same_ticker: 'Ticker prior win rate',
    score: 'Heuristic score',
    trigger_ask_pct: 'Ask-side %',
    trigger_iv: 'IV',
    trigger_delta: 'Delta',
    spike_ratio: 'Spike ratio',
    ask_pct: 'Ask %',
    vol_oi: 'Vol/OI',
    multi_leg_share: 'Multi-leg share',
    mkt_tide_diff: 'Market tide',
    mkt_tide_otm_diff: 'OTM tide',
    cheap_call_pm_tagged: 'Cheap-call PM',
    reload_tagged: 'Reload',
    direction_gated: 'Direction gated',
  };
  if (rawName in map) return map[rawName]!;
  // Strip one-hot suffix for ticker_bucket_TSLA / option_type_C / etc.
  if (rawName.startsWith('ticker_bucket_')) {
    return rawName.replace('ticker_bucket_', '');
  }
  if (rawName.startsWith('option_type_')) {
    return rawName === 'option_type_C' ? 'Call' : 'Put';
  }
  if (rawName.startsWith('mode_')) {
    return rawName.replace('mode_', '').replaceAll('_', ' ');
  }
  if (rawName.startsWith('tod_')) {
    return rawName.replace('tod_', '').replaceAll('_', ' ');
  }
  if (rawName.startsWith('flow_quad_')) {
    return rawName.replace('flow_quad_', '');
  }
  if (rawName.startsWith('score_tier_')) {
    return rawName.replace('score_tier_', '');
  }
  return rawName;
}

/** Coerce the JSONB blob from the API into the typed shape. Returns null
 *  on any structural surprise so the UI degrades to "no flags". */
function parseTopFeatures(
  raw: Record<string, unknown> | null | undefined,
): TakeitTopFeatures | null {
  if (raw == null) return null;
  const positive = Array.isArray(raw.positive) ? raw.positive : [];
  const negative = Array.isArray(raw.negative) ? raw.negative : [];
  return {
    positive: positive as ShapContribution[],
    negative: negative as ShapContribution[],
  };
}

function FlagChips({
  contributions,
  variant,
}: {
  contributions: ShapContribution[];
  variant: 'positive' | 'negative';
}) {
  if (contributions.length === 0) return null;
  const dotCls = variant === 'positive' ? 'bg-emerald-400' : 'bg-rose-400';
  return (
    <div className="flex flex-wrap items-center gap-1">
      {contributions.slice(0, 3).map((c) => (
        <span
          key={c.name}
          className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900/60 px-1.5 py-0.5 text-[10px] text-neutral-200"
          title={`SHAP ${c.shap_value.toFixed(3)} · value ${String(c.feature_value)}`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dotCls}`} />
          {featureLabel(c.name)}
        </span>
      ))}
    </div>
  );
}

function TakeItScoreInner(props: TakeItScoreProps) {
  const {
    prob,
    topFeatures,
    compact = false,
    expanded = false,
    peakProb,
    peakAt,
  } = props;
  const parsed = parseTopFeatures(topFeatures);
  // Show the peak marker only when the chain peaked meaningfully above
  // the latest fire's prob (≥ 0.01 at 2-dp display resolution). Equal /
  // latest-is-peak chains don't need it. `prob == null` (bundle missing
  // on the latest fire) still benefits from showing the chain's peak.
  const peakRounded = peakProb != null ? Number(peakProb.toFixed(2)) : null;
  const probRounded = prob != null ? Number(prob.toFixed(2)) : null;
  const showPeak =
    peakRounded != null && (probRounded == null || peakRounded > probRounded);
  const peakTime = showPeak ? formatPeakTimeCt(peakAt) : '';
  // Built outside the JSX to avoid a nested template literal (SonarJS).
  const peakWhen = peakTime ? ` at ${peakTime} CT` : '';
  const peakTitle = showPeak
    ? `Chain peaked at TAKE-IT ${peakRounded!.toFixed(2)}${peakWhen}. The feed keeps a chain visible on its peak (not the latest fire), so it never disappears intraday once it clears the floor.`
    : undefined;
  const cls = takeitProbClass(prob);
  const padding = compact ? 'px-1.5 py-0.5' : 'px-2 py-1';
  const labelPrefix = compact ? '' : 'Take-It ';

  // Hide entirely when there's nothing useful to show: no latest-fire
  // prob, no flags, AND no chain peak to surface. When `showPeak` is true
  // the chain is on the feed BECAUSE of its peak (the latest fire's
  // bundle was unreachable, so prob/flags are both null) — keep the tile
  // so the peak marker still renders and explains its presence.
  if (prob == null && parsed == null && !showPeak) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid="takeit-score-tile"
    >
      <span
        className={`inline-flex items-center gap-1 rounded border ${cls} ${padding} text-[10px] font-semibold tracking-wide uppercase`}
        title={
          prob == null
            ? 'No score — the model bundle was unavailable when this alert fired.'
            : 'How confident the model is this trade reaches at least +20% above entry. 0–1, higher is better; ~0.70+ is where the historical edge concentrates.'
        }
        data-testid="takeit-score-chip"
      >
        <span className="opacity-70">{labelPrefix}</span>
        <span className="tabular-nums">{formatProb(prob)}</span>
      </span>
      {showPeak && (
        <span
          className="inline-flex items-center gap-1 rounded border border-emerald-700/50 bg-emerald-950/30 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-emerald-300/90 uppercase"
          title={peakTitle}
          data-testid="takeit-peak-marker"
        >
          peak {peakRounded!.toFixed(2)}
          {peakTime && <span className="opacity-70">@ {peakTime}</span>}
        </span>
      )}
      {prob != null && parsed == null && (
        <span
          className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-500"
          title="SHAP flags arrive ~2 min after the alert fires"
        >
          flags…
        </span>
      )}
      {expanded && parsed && (
        <>
          <FlagChips contributions={parsed.positive} variant="positive" />
          <FlagChips contributions={parsed.negative} variant="negative" />
        </>
      )}
    </div>
  );
}

/**
 * Re-render is gated on the value props alone; the row component passes
 * fresh objects on every parent render and memo prevents repaint thrash
 * when only neighboring badges change.
 */
export const TakeItScore = memo(TakeItScoreInner);
