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
  const { data, loading, error, isWindowOpen } = useOpeningFlowSignal();

  const headerStatusLabel = describeStatus(data?.windowStatus, isWindowOpen);

  return (
    <section
      className="rounded-lg border border-slate-700 bg-slate-900/60 p-4"
      aria-labelledby="opening-flow-heading"
    >
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2
            id="opening-flow-heading"
            className="text-sm font-semibold tracking-wide text-slate-200 uppercase"
          >
            Opening Flow Signal
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            V4 rule · SPY + QQQ · 0DTE · 08:30–08:45 CT window
          </p>
        </div>
        <span
          className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-slate-300"
          aria-live="polite"
        >
          {headerStatusLabel}
        </span>
      </header>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-red-800 bg-red-900/40 px-3 py-2 text-xs text-red-200"
        >
          {error}
        </div>
      )}

      {!data && !isWindowOpen && (
        <p className="text-xs text-slate-400">
          Outside the signal window. The panel auto-updates between 08:25 and
          08:50 CT on trading days.
        </p>
      )}

      {data && (
        <div className="grid gap-3 sm:grid-cols-2">
          {(['SPY', 'QQQ'] as const).map((ticker) => (
            <SignalCard
              key={ticker}
              ticker={ticker}
              payload={data.tickers[ticker] ?? null}
              windowStatus={data.windowStatus}
              stopPct={data.stopPct}
              exitMinutesFromEntry={data.exitMinutesFromEntry}
              loading={loading}
            />
          ))}
        </div>
      )}
    </section>
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
