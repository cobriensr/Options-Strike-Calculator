/**
 * VixDealerStateBadge — shows whether VIX itself is in long-gamma
 * (vol-of-vol compressed → SPX vol likely sticky) or short-gamma
 * (vol-of-vol expanding → SPX vol may spike).
 *
 * VIX dealer positioning is a meta-signal: when VIX option dealers are
 * short gamma, VIX moves get amplified (mechanical hedging is
 * procyclical), and SPX implied vol expands procyclically with VIX.
 * Useful as a regime gate for lottery alerts.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';
import { deriveGammaSign, type GammaSign } from './types';

interface VixDealerStateBadgeProps {
  marketOpen: boolean;
}

const SPEC = { view: 'snapshots-latest' as const };

function formatLevel(value: number | null): string {
  if (value == null) return '—';
  return value.toFixed(2);
}

function VixDealerStateBadgeInner({ marketOpen }: VixDealerStateBadgeProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);

  const { sign, spot, zeroGamma } = useMemo(() => {
    const vix = rows.find((r) => r.ticker === 'VIX');
    return {
      sign: deriveGammaSign(vix?.spot ?? null, vix?.zeroGamma ?? null),
      spot: vix?.spot ?? null,
      zeroGamma: vix?.zeroGamma ?? null,
    };
  }, [rows]);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="vix-dealer-state-badge-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        VIX Dealer State — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="vix-dealer-state-badge-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        VIX Dealer State — {error}
      </div>
    );
  }

  // Empty-state: tables empty until Monday 13:00 UTC.
  if (rows.length === 0 || sign === 'unknown') {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="vix-dealer-state-badge-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        VIX Dealer State — awaiting first GEXBot tick
      </div>
    );
  }

  return <Badge sign={sign} spot={spot} zeroGamma={zeroGamma} />;
}

interface BadgeProps {
  sign: GammaSign;
  spot: number | null;
  zeroGamma: number | null;
}

function Badge({ sign, spot, zeroGamma }: BadgeProps) {
  const isLong = sign === 'long';
  const containerClass = isLong
    ? 'border-emerald-500/30 bg-emerald-500/10'
    : 'border-rose-500/30 bg-rose-500/10';
  const dotClass = isLong ? 'bg-emerald-400' : 'bg-rose-400';
  const headlineClass = isLong ? 'text-emerald-300' : 'text-rose-300';

  const label = isLong ? 'LONG GAMMA' : 'SHORT GAMMA';
  const subline = isLong
    ? 'vol-of-vol compressed regime'
    : 'vol-of-vol expansion regime';

  const ariaLabel = `VIX dealers ${
    isLong ? 'long' : 'short'
  } gamma — spot ${formatLevel(spot)}, zero-gamma ${formatLevel(zeroGamma)}, ${subline}`;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      className={`flex items-center gap-3 rounded-md border px-3 py-2 ${containerClass}`}
      data-testid="vix-dealer-state-badge"
    >
      <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
      <div className="flex flex-col leading-tight">
        <span
          className={`text-xs font-semibold tracking-wide ${headlineClass}`}
        >
          VIX · {label}
        </span>
        <span className="text-tertiary text-[10px]">
          spot {formatLevel(spot)} · zero-gamma {formatLevel(zeroGamma)} ·{' '}
          {subline}
        </span>
      </div>
    </div>
  );
}

export const VixDealerStateBadge = memo(VixDealerStateBadgeInner);
