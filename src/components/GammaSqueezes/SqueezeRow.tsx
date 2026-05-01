/**
 * Per-active-squeeze row in the GammaSqueezeFeed.
 *
 * Compact one-line layout: ticker/strike/side, velocity pill, acceleration
 * pill, spot-vs-strike pill, trend pill, NDG sign, phase pill, freshness.
 * No expanded view (yet) — this is a glance dashboard, not a deep-drill
 * detail panel like AnomalyRow.
 */

import { useEffect, useState } from 'react';
import type { ActiveSqueeze, GammaSqueezeSide } from './types';

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
  // Path-shape staleness flag from the read endpoint (2026-04-29 outlier
  // suppressor): >30 min old AND <25% progress toward strike. Render with
  // a dimmed row + a 'stale' pill so the user can see-but-de-prioritize.
  const isStale = latest.isStale === true;
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
  const sideChar = isCall ? 'C' : 'P';
  const contractLabel = `${squeeze.ticker} ${latest.strike}${sideChar}`;
  const occSymbol = buildOccSymbol(
    squeeze.ticker,
    squeeze.expiry,
    latest.side,
    latest.strike,
  );

  return (
    <div
      className={`border-edge bg-surface-alt flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 ${isStale ? 'opacity-60' : ''}`}
      data-testid={`squeeze-row-${squeeze.compoundKey}`}
      data-stale={isStale ? 'true' : undefined}
    >
      <span className="text-primary font-mono text-xs font-semibold">
        {directionArrow}{' '}
        {occSymbol ? (
          <a
            href={`https://unusualwhales.com/option-chain/${encodeURIComponent(occSymbol)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
            title={`View ${occSymbol} on Unusual Whales`}
            aria-label={`Open ${contractLabel} on Unusual Whales (opens in new tab)`}
          >
            {contractLabel}
          </a>
        ) : (
          contractLabel
        )}
      </span>

      <span className="text-muted font-mono text-[10px]">{squeeze.expiry}</span>

      {isStale ? (
        <span
          className="rounded-md bg-zinc-500/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-zinc-300"
          data-testid="squeeze-stale-badge"
          title={
            `Stale: ${Math.round(latest.freshnessMin)} min since detection, ` +
            `${
              latest.progressPct == null
                ? 'unknown progress'
                : `${(latest.progressPct * 100).toFixed(0)}% progress toward strike`
            }. Outlier study found wins like this round-trip 56% at close — de-prioritize.`
          }
        >
          stale
        </span>
      ) : null}

      {latest.precisionStackPass ? (
        <span
          className="rounded-md bg-amber-400/25 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-200"
          data-testid="squeeze-precision-pass"
          title={
            'Precision stack PASS — diffuse cross-strike neighborhood ' +
            '(low HHI) AND morning IV rose with volume (real demand). ' +
            `In-sample precision ~48% vs 17% base. ` +
            (latest.hhiNeighborhood != null
              ? `HHI=${latest.hhiNeighborhood.toFixed(3)}`
              : 'HHI=—') +
            ', ' +
            (latest.ivMorningVolCorr != null
              ? `iv-corr=${latest.ivMorningVolCorr.toFixed(2)}`
              : 'iv-corr=—')
          }
        >
          ★ precision
        </span>
      ) : null}

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

/**
 * OCC option symbol for deep-linking the contract row into the
 * Unusual Whales option-chain page. Returns null on a malformed
 * expiry so the caller falls back to plain text rather than render
 * a broken URL. Mirrors the helper in IVAnomalies/AnomalyRow.tsx.
 */
function buildOccSymbol(
  ticker: string,
  expiry: string,
  side: GammaSqueezeSide,
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
