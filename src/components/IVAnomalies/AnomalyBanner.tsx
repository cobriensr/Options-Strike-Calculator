import { useEffect, useState } from 'react';
import { ivAnomalyBannerStore, type BannerSnapshot } from './banner-store';
import type { IVAnomalyFlowPhase, IVAnomalyRow } from './types';

/**
 * Fixed-position top banner stack for new IV anomalies.
 *
 * Subscribes to the module-level `ivAnomalyBannerStore` (populated by
 * `useIVAnomalies`). Renders up to N = 3 visible cards with auto-dismiss
 * timers managed inside the store; older entries collapse into a
 * `+N more` chip. Each card click dismisses the banner; the auto-dismiss
 * timer fires independently.
 *
 * Positioned at `top-16` (below the existing AlertBanner's `top-0`) so
 * the two banner systems don't overlap. z-50 keeps it above GEX panels
 * without competing with Vercel's toolbar.
 */
export function AnomalyBanner() {
  const [snapshot, setSnapshot] = useState<BannerSnapshot>(() =>
    ivAnomalyBannerStore.getSnapshot(),
  );

  useEffect(() => {
    return ivAnomalyBannerStore.subscribe(setSnapshot);
  }, []);

  if (snapshot.visible.length === 0) return null;

  return (
    <div
      className="fixed top-16 right-2 z-50 flex w-[360px] max-w-[90vw] flex-col gap-2"
      role="region"
      aria-label="Recent IV anomalies"
    >
      {snapshot.visible.map((entry) => (
        <BannerCard
          key={entry.id}
          anomaly={entry.anomaly}
          onDismiss={() => ivAnomalyBannerStore.dismiss(entry.id)}
        />
      ))}
      {snapshot.overflowCount > 0 && (
        <div className="border-edge bg-surface-alt text-muted rounded-md border px-3 py-1 text-center font-mono text-[11px]">
          +{snapshot.overflowCount} more anomal
          {snapshot.overflowCount === 1 ? 'y' : 'ies'}
        </div>
      )}
    </div>
  );
}

function BannerCard({
  anomaly,
  onDismiss,
}: {
  readonly anomaly: IVAnomalyRow;
  readonly onDismiss: () => void;
}) {
  const phase = anomaly.flowPhase;
  const phaseColor = phaseAccent(phase);

  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={`Dismiss ${anomaly.ticker} ${anomaly.strike} ${anomaly.side} anomaly`}
      className="border-edge bg-surface hover:bg-surface-alt animate-fade-in-up flex flex-col items-start gap-1 rounded-md border-[1.5px] px-3 py-2 text-left shadow-lg transition-colors"
      style={{ borderLeftColor: phaseColor, borderLeftWidth: 3 }}
    >
      <div className="flex w-full items-center gap-2">
        <span className="text-primary font-mono text-xs font-semibold">
          {anomaly.ticker} {formatStrike(anomaly.strike)}
          {anomaly.side === 'put' ? 'P' : 'C'}
        </span>
        <PhasePill phase={phase} />
        <span className="text-muted ml-auto font-mono text-[10px]">
          {formatTs(anomaly.ts)}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {anomaly.flagReasons.map((reason) => (
          <span
            key={reason}
            className="bg-accent-bg text-accent rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
          >
            {reason}
          </span>
        ))}
      </div>
      <div className="text-muted text-[10px]">
        spot {anomaly.spotAtDetect.toFixed(2)} · IV{' '}
        {(anomaly.ivAtDetect * 100).toFixed(1)}%
      </div>
    </button>
  );
}

function PhasePill({ phase }: { readonly phase: IVAnomalyFlowPhase | null }) {
  if (!phase) {
    return (
      <span className="rounded-full bg-slate-700/40 px-2 py-0.5 font-mono text-[10px] font-semibold text-slate-300">
        ?
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

function phaseAccent(phase: IVAnomalyFlowPhase | null): string {
  switch (phase) {
    case 'early':
      return 'rgb(16, 185, 129)'; // emerald-500
    case 'mid':
      return 'rgb(245, 158, 11)'; // amber-500
    case 'reactive':
      return 'rgb(244, 63, 94)'; // rose-500
    default:
      return 'rgb(100, 116, 139)'; // slate-500
  }
}

function formatStrike(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
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
