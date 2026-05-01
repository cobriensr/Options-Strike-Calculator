/**
 * Per-active-squeeze row in the GammaSqueezeFeed.
 *
 * Compact one-line layout: ticker/strike/side, velocity pill, acceleration
 * pill, spot-vs-strike pill, trend pill, NDG sign, phase pill, freshness.
 * No expanded view (yet) — this is a glance dashboard, not a deep-drill
 * detail panel like AnomalyRow.
 */

import { useEffect, useState } from 'react';
import type { ActiveSqueeze, GammaSqueezeSide, TapeAgreement } from './types';

function fmtPremium(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return '—';
  const abs = Math.abs(x);
  const sign = x < 0 ? '−' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function tapeAgreementTooltip(
  side: GammaSqueezeSide,
  t: TapeAgreement,
): string {
  const expected =
    side === 'call'
      ? 'For a CALL alert, each signal agrees when NCP > NPP (call premium dominating).'
      : 'For a PUT alert, each signal agrees when NCP < NPP (put premium dominating).';
  const lines = [
    `Tape confirmation: ${t.agreeCount} / ${t.total} signals agree with the ${side} direction.`,
    expected,
    '',
  ];
  for (const s of t.signals) {
    const verdict =
      s.agrees === true ? '✓' : s.agrees === false ? '✗' : '— (no data)';
    const values =
      s.ncp != null && s.npp != null
        ? `NCP ${fmtPremium(s.ncp)} vs NPP ${fmtPremium(s.npp)}`
        : 'no data today';
    lines.push(`  ${verdict} ${s.label}: ${values}`);
  }
  return lines.join('\n');
}

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
      <span
        className="text-primary font-mono text-xs font-semibold"
        title={
          isCall
            ? `Call alert — squeeze setup expects spot to push UP into ${latest.strike}.`
            : `Put alert — squeeze setup expects spot to push DOWN into ${latest.strike}.`
        }
      >
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

      <span
        className="text-muted font-mono text-[10px]"
        title="Option expiration date (0DTE = expires today)"
      >
        {squeeze.expiry}
      </span>

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
        title={
          latest.squeezePhase === 'active'
            ? 'ACTIVE — velocity ≥ threshold AND spot within 0.5% of strike. Squeeze is engaged; trade window now.'
            : latest.squeezePhase === 'forming'
              ? 'FORMING — velocity ≥ threshold but spot still > 0.5% from strike. Setup building; wait for spot to close in.'
              : 'EXHAUSTED — spot pierced strike OR velocity dropped below threshold. Trade window has likely passed.'
        }
      >
        {latest.squeezePhase}
      </span>

      <span
        className="rounded-md bg-fuchsia-500/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-fuchsia-200"
        title={
          `Velocity gate (Gate 1): vol/OI added in last 15 minutes. ` +
          `Threshold to fire = 5×. Higher = more concentrated buying. ` +
          `Current value: ${fmtRatio(latest.volOi15m)}`
        }
      >
        vel {fmtRatio(latest.volOi15m)}
      </span>

      <span
        className="rounded-md bg-fuchsia-500/15 px-2 py-0.5 font-mono text-[10px] text-fuchsia-300"
        title={
          `Acceleration gate (Gate 2): current velocity must be ≥ 1.5× the prior 15-min velocity. ` +
          `Prior 15-min velocity = ${fmtRatio(latest.volOi15mPrior)}. ` +
          `Acceleration shown is the difference (current − prior).`
        }
      >
        accel +{fmtRatio(latest.volOiAcceleration)}
      </span>

      <span
        className={`${
          Math.abs(latest.pctFromStrike) <= 0.005
            ? 'bg-emerald-500/20 text-emerald-200'
            : 'bg-amber-500/15 text-amber-300'
        } rounded-md px-2 py-0.5 font-mono text-[10px]`}
        title={
          `Proximity gate (Gate 3): spot ${latest.spotAtDetect.toFixed(2)} vs strike ${latest.strike}. ` +
          `Calls fire when spot is between 1.5% below and 0.5% above the strike. ` +
          `Green = within 0.5% (active band); amber = forming (still 0.5-1.5% away).`
        }
      >
        spot {fmtSignedPct(latest.pctFromStrike)}
      </span>

      <span
        className="rounded-md bg-sky-500/20 px-2 py-0.5 font-mono text-[10px] text-sky-300"
        title={
          `Trend gate (Gate 4): spot move over last 5 min. ` +
          `Calls require ≥ +0.05% (positive); puts require ≤ -0.05%. ` +
          `Trend tells you the squeeze is moving toward the strike, not stalling.`
        }
      >
        trend {fmtSignedPct(latest.spotTrend5m, 3)}
      </span>

      <span
        className={`${ndgClass} rounded-md px-2 py-0.5 font-mono text-[10px]`}
        title={
          latest.netGammaSign === 'short'
            ? 'NDG (Net Dealer Gamma) gate: dealers are NET SHORT gamma at this strike. Their hedging buys/sells AMPLIFIES the move into the strike — favored direction.'
            : latest.netGammaSign === 'unknown'
              ? 'NDG (Net Dealer Gamma): not available for this ticker. SPX/SPY/QQQ have strike-level NDG; single-names skip this gate.'
              : 'NDG (Net Dealer Gamma): dealers net LONG gamma. Hedging DAMPENS moves. Should not appear here — filtered upstream by Gate 6.'
        }
      >
        γ {latest.netGammaSign}
      </span>

      {latest.tapeAgreement.total > 0 ? (
        <span
          className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold ${
            latest.tapeAgreement.agreeCount === latest.tapeAgreement.total
              ? 'bg-lime-500/25 text-lime-200'
              : latest.tapeAgreement.agreeCount * 2 >=
                  latest.tapeAgreement.total
                ? 'bg-lime-500/15 text-lime-300'
                : 'bg-rose-500/15 text-rose-300'
          }`}
          data-testid="squeeze-tape-agreement"
          title={tapeAgreementTooltip(latest.side, latest.tapeAgreement)}
        >
          tape {latest.tapeAgreement.agreeCount}/{latest.tapeAgreement.total}
        </span>
      ) : null}

      <span
        className="text-muted ml-auto font-mono text-[10px]"
        title="Number of times this compound key has fired in the active span."
      >
        firings: {squeeze.firingCount}
      </span>
      <span
        className="text-muted font-mono text-[10px]"
        title={`Most recent firing: ${new Date(latest.ts).toLocaleString()}`}
      >
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
