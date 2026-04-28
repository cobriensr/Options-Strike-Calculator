/**
 * Per-active-squeeze row in the GammaSqueezeFeed.
 *
 * Compact one-line layout: ticker/strike/side, velocity pill, acceleration
 * pill, spot-vs-strike pill, trend pill, NDG sign, phase pill, freshness.
 * No expanded view (yet) — this is a glance dashboard, not a deep-drill
 * detail panel like AnomalyRow.
 */

import { useEffect, useState } from 'react';
import type { ActiveSqueeze } from './types';

function fmtSignedPct(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '—';
  const sign = x > 0 ? '+' : '';
  return `${sign}${(x * 100).toFixed(digits)}%`;
}

function fmtRatio(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '—';
  return `${x.toFixed(digits)}×`;
}

function fmtFreshness(deltaMs: number): string {
  const seconds = Math.max(0, Math.round(deltaMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function SqueezeRow({ squeeze }: { readonly squeeze: ActiveSqueeze }) {
  const latest = squeeze.latest;

  // Live "last fire 42s ago" label — refresh every 15s.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const freshnessMs = nowMs - Date.parse(latest.ts);

  const isCall = latest.side === 'call';
  // Phase color tier.
  const phaseClass =
    latest.squeezePhase === 'active'
      ? 'bg-rose-500/25 text-rose-200'
      : latest.squeezePhase === 'forming'
        ? 'bg-amber-500/25 text-amber-200'
        : 'bg-zinc-500/20 text-zinc-400';

  // NDG color: short = lime (squeeze-favored), long = gray (filtered upstream
  // so won't appear here, defensive only), unknown = neutral.
  const ndgClass =
    latest.netGammaSign === 'short'
      ? 'bg-lime-500/20 text-lime-300'
      : 'bg-zinc-500/20 text-zinc-400';

  const directionArrow = isCall ? '↑' : '↓';

  return (
    <div
      className="border-edge bg-surface-alt flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
      data-testid={`squeeze-row-${squeeze.compoundKey}`}
    >
      <span className="text-primary font-mono text-xs font-semibold">
        {directionArrow} {squeeze.ticker} {latest.strike}
        {isCall ? 'C' : 'P'}
      </span>

      <span className="text-muted font-mono text-[10px]">{squeeze.expiry}</span>

      <span
        className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-bold ${phaseClass}`}
        data-testid={`squeeze-phase-${latest.squeezePhase}`}
      >
        {latest.squeezePhase}
      </span>

      <span
        className="rounded-md bg-fuchsia-500/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-fuchsia-200"
        title="vol/OI added in last 15 minutes"
      >
        vel {fmtRatio(latest.volOi15m)}
      </span>

      <span
        className="rounded-md bg-fuchsia-500/15 px-2 py-0.5 font-mono text-[10px] text-fuchsia-300"
        title={`prior 15-min velocity: ${fmtRatio(latest.volOi15mPrior)}`}
      >
        accel +{fmtRatio(latest.volOiAcceleration)}
      </span>

      <span
        className={`${
          Math.abs(latest.pctFromStrike) <= 0.005
            ? 'bg-emerald-500/20 text-emerald-200'
            : 'bg-amber-500/15 text-amber-300'
        } rounded-md px-2 py-0.5 font-mono text-[10px]`}
        title={`spot ${latest.spotAtDetect.toFixed(2)} vs strike ${latest.strike}`}
      >
        spot {fmtSignedPct(latest.pctFromStrike)}
      </span>

      <span
        className="rounded-md bg-sky-500/20 px-2 py-0.5 font-mono text-[10px] text-sky-300"
        title="5-min spot trend"
      >
        trend {fmtSignedPct(latest.spotTrend5m, 3)}
      </span>

      <span
        className={`${ndgClass} rounded-md px-2 py-0.5 font-mono text-[10px]`}
        title={
          latest.netGammaSign === 'short'
            ? 'Dealers net SHORT gamma at this strike — hedging amplifies moves'
            : latest.netGammaSign === 'unknown'
              ? 'NDG not available for this ticker (single names lack strike_exposures)'
              : 'Dealers net LONG gamma (should not appear; filtered upstream)'
        }
      >
        γ {latest.netGammaSign}
      </span>

      <span className="text-muted ml-auto font-mono text-[10px]">
        firings: {squeeze.firingCount}
      </span>
      <span className="text-muted font-mono text-[10px]">
        last {fmtFreshness(freshnessMs)}
      </span>
    </div>
  );
}
