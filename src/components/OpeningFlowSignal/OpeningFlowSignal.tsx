/**
 * Opening Flow Signal — V4 rule live monitor for SPY and QQQ during
 * the 09:30–09:45 ET window. Surfaces the qualifying contract to
 * trade if conditions hold.
 *
 * Historical mode: the date picker lets the user browse any prior
 * trading day's evaluator output that the persistent DB store has
 * captured. Picking a date stops polling and shows that day's static
 * payload; pressing "Live" returns to the polling/live view.
 *
 * Spec: docs/superpowers/specs/opening-flow-signal-historical-persistence-2026-05-19.md
 */

import { useState } from 'react';
import { useOpeningFlowSignal } from '../../hooks/useOpeningFlowSignal.js';
import { getETToday } from '../../utils/timezone.js';
import { DateInput } from '../ui/DateInput.js';
import { SignalCard } from './SignalCard.js';

export function OpeningFlowSignal(): React.ReactElement {
  const [selectedDate, setSelectedDate] = useState<string>('');
  const { displayData, loading, error, isWindowOpen, isHistorical } =
    useOpeningFlowSignal(selectedDate);

  const headerStatusLabel = describeStatus(
    displayData?.windowStatus,
    isWindowOpen,
  );

  const today = getETToday();

  // "Data not captured" empty state: historical mode where the window
  // is reported closed but every ticker payload is empty / no signal.
  // This is the case spec-open-question #2 — pre-Phase-1 dates have no
  // captured snapshot in the DB store so the endpoint returns an empty
  // shell.
  const isDataNotCaptured =
    isHistorical &&
    displayData != null &&
    displayData.windowStatus === 'closed' &&
    Object.values(displayData.tickers).every(
      (t) =>
        t == null || (t.slice1 == null && t.slice2 == null && t.signal == null),
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
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <DateInput
              value={selectedDate}
              onChange={(next) => {
                // Coerce today's date back to live mode. Without this,
                // picking today in the date input would issue
                // `?date=today` and put the hook in historical mode
                // (no polling, one-shot read) — surprising UX when the
                // user clearly expects fresh data for today.
                setSelectedDate(next === today ? '' : next);
              }}
              label="Date"
              max={today}
            />
            <button
              type="button"
              onClick={() => setSelectedDate('')}
              disabled={selectedDate === ''}
              className="border-edge bg-surface-alt text-text hover:bg-surface-alt/70 rounded border px-2 py-0.5 font-sans text-[10px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              Live
            </button>
            <span className="text-tertiary font-sans text-[10px]">
              {isHistorical ? `Historical · ${selectedDate}` : 'Live'}
            </span>
          </div>
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

      {!displayData && !isWindowOpen && !isHistorical && (
        <p className="text-secondary font-sans text-[11px]">
          Outside the signal window. The panel auto-updates between 08:25 and
          08:50 CT on trading days.
        </p>
      )}

      {isDataNotCaptured && (
        <p className="text-secondary font-sans text-[11px]">
          Data not captured for this date.
        </p>
      )}

      {displayData && !isDataNotCaptured && (
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
