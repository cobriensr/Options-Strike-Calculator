/**
 * Opening Flow Signal — V4 rule live monitor for SPY and QQQ during
 * the 09:30–09:45 ET window. Surfaces the qualifying contract to
 * trade if conditions hold.
 *
 * Spec: docs/superpowers/specs/opening-flow-signal-2026-05-14.md
 */

import { useOpeningFlowSignal } from '../../hooks/useOpeningFlowSignal.js';
import { SignalCard } from './SignalCard.js';

export function OpeningFlowSignal(): React.ReactElement {
  const { displayData, loading, error, isWindowOpen } = useOpeningFlowSignal();

  const headerStatusLabel = describeStatus(
    displayData?.windowStatus,
    isWindowOpen,
  );

  return (
    <div aria-labelledby="opening-flow-heading">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id="opening-flow-heading"
            className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
          >
            Opening Flow Signal
          </h3>
          <p className="text-muted mt-0.5 font-sans text-[10px]">
            V4 rule · SPY + QQQ · 0DTE · 08:30–08:45 CT window
          </p>
        </div>
        <span
          className="bg-chip-bg text-secondary rounded-full px-2 py-0.5 font-sans text-[10px] font-medium whitespace-nowrap"
          aria-live="polite"
        >
          {headerStatusLabel}
        </span>
      </header>

      {error && (
        <div
          role="alert"
          className="mb-2 rounded border border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-200"
        >
          {error}
        </div>
      )}

      {!displayData && !isWindowOpen && (
        <p className="text-secondary font-sans text-[11px]">
          Outside the signal window. The panel auto-updates between 08:25 and
          08:50 CT on trading days.
        </p>
      )}

      {displayData && (
        <div className="grid gap-2 sm:grid-cols-2">
          {(['SPY', 'QQQ'] as const).map((ticker) => (
            <SignalCard
              key={ticker}
              ticker={ticker}
              payload={displayData.tickers[ticker] ?? null}
              windowStatus={displayData.windowStatus}
              stopPct={displayData.stopPct}
              exitMinutesFromEntry={displayData.exitMinutesFromEntry}
              expiryDate={displayData.date}
              loading={loading}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function describeStatus(
  status: string | undefined,
  isWindowOpen: boolean,
): string {
  if (!status) return isWindowOpen ? 'Loading…' : 'Idle';
  switch (status) {
    case 'before_open':
      return 'Before open';
    case 'slice1':
      return 'Slice 1 — 08:30–08:35 CT';
    case 'slice2':
      return 'Slice 2 — 08:35–08:40 CT';
    case 'evaluating':
      return 'Evaluating (locked at 08:40 CT)';
    case 'closed':
      return 'Window closed';
    default:
      return status;
  }
}
