/**
 * FireRow — one row in the Gamma-Node Composite Detector tile's fire list.
 *
 * Layout (mirrors EventDayWarning's event-row pattern):
 *   [SIGNAL TYPE BADGE]  Strike NNNN | sub-description       HH:MM CT
 *
 * Signal-type color mapping comes from the spec:
 *   - e1_long_call  → theme.green   (bullish breakthrough)
 *   - e5_long_put   → theme.red     (bearish breakdown)
 *   - pcs_monday    → theme.accent  (premium-sell on Monday rejection)
 *
 * When the row has a resolved `ret_30m` (backfilled post-close), the
 * sub-description shows the realized direction-adjusted SPX move so the
 * user can see hit/miss without leaving the tile. While the fire is still
 * pending its outcome (cron hasn't run yet), the sub-description shows the
 * setup context instead.
 */

import { memo } from 'react';

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { GammaSetupFire, SignalType } from '../../hooks/useGammaSetups';

interface FireRowProps {
  fire: GammaSetupFire;
}

function signalColor(signal: SignalType): string {
  switch (signal) {
    case 'e1_long_call':
      return theme.green;
    case 'e5_long_put':
      return theme.red;
    case 'pcs_monday':
      return theme.accent;
  }
}

function signalLabel(signal: SignalType): string {
  switch (signal) {
    case 'e1_long_call':
      return 'E1';
    case 'e5_long_put':
      return 'E5';
    case 'pcs_monday':
      return 'PCS';
  }
}

function signalTitle(signal: SignalType): string {
  switch (signal) {
    case 'e1_long_call':
      return 'E1 — Long call on +γ ceiling breakthrough + 3-bar hold';
    case 'e5_long_put':
      return 'E5 — Long put on failed-reversal breakdown of +γ floor';
    case 'pcs_monday':
      return 'PCS — Put credit spread on Monday +γ floor rejection';
  }
}

function setupDescription(fire: GammaSetupFire): string {
  switch (fire.signal_type) {
    case 'e1_long_call':
      return 'breakthrough confirmed, 3-bar hold';
    case 'e5_long_put':
      return 'failed-bounce breakdown';
    case 'pcs_monday': {
      if (fire.es_basis_change_5m == null) return 'rejection — ES basis n/a';
      const sign = fire.es_basis_change_5m >= 0 ? '+' : '';
      return `rejection — ES basis ${sign}${fire.es_basis_change_5m.toFixed(1)}`;
    }
  }
}

function outcomeText(retPts: number): string {
  const sign = retPts >= 0 ? '+' : '';
  return `${sign}${retPts.toFixed(1)} pts @ +30m`;
}

function outcomeColor(retPts: number): string {
  return retPts >= 0 ? theme.green : theme.red;
}

/** Format `fired_at` (ISO string) in America/Chicago HH:MM. */
function formatCt(isoTs: string): string {
  return new Date(isoTs).toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export const FireRow = memo(function FireRow({ fire }: FireRowProps) {
  const sigColor = signalColor(fire.signal_type);
  const hasOutcome = fire.ret_30m != null;
  const outcomePts = fire.ret_30m;

  return (
    <div
      className="flex items-center gap-2.5 py-1.5"
      data-testid={`gamma-fire-${fire.id}`}
    >
      <span
        className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.06em] uppercase"
        style={{ backgroundColor: tint(sigColor, '18'), color: sigColor }}
        title={signalTitle(fire.signal_type)}
      >
        {signalLabel(fire.signal_type)}
      </span>
      <span className="text-primary font-sans text-xs font-medium">
        Strike {fire.node_strike}
        <span className="text-muted"> | {setupDescription(fire)}</span>
      </span>
      {hasOutcome && outcomePts != null && (
        <span
          className="shrink-0 font-mono text-[11px] font-semibold"
          style={{ color: outcomeColor(outcomePts) }}
          title="Realized direction-adjusted return at +30m vs fire bar close"
        >
          {outcomeText(outcomePts)}
        </span>
      )}
      <span className="text-muted ml-auto shrink-0 font-mono text-[11px]">
        {formatCt(fire.fired_at)} CT
      </span>
    </div>
  );
});
