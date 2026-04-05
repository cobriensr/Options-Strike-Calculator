/**
 * AnalysisHistoryPicker — Mode filter tabs, date/time/mode pickers,
 * run selector, loading, empty state, and results display.
 *
 * Pure presentation component — all state is lifted to AnalysisHistory.
 */

import { theme } from '../../themes';
import type {
  AnalysisEntry,
  AnalysisMode,
  DateEntry,
  ModeFilter,
} from './types';
import { MODE_LABELS } from './types';
import { ErrorMsg } from '../ui';
import { tint } from '../../utils/ui-utils';
import AnalysisHistoryItem from './AnalysisHistoryItem';

interface Props {
  readonly modeFilter: ModeFilter;
  readonly onModeFilterChange: (filter: ModeFilter) => void;
  readonly fetchError: string | null;
  readonly filteredDates: readonly DateEntry[];
  readonly selectedDate: string;
  readonly onDateChange: (date: string) => void;
  readonly availableTimes: readonly string[];
  readonly selectedTime: string;
  readonly onTimeChange: (time: string) => void;
  readonly availableModes: readonly AnalysisMode[];
  readonly selectedMode: AnalysisMode | '';
  readonly onModeChange: (mode: AnalysisMode) => void;
  readonly runsAtTimeMode: readonly AnalysisEntry[];
  readonly selectedRunIndex: number;
  readonly onRunIndexChange: (index: number) => void;
  readonly selectedAnalysis: AnalysisEntry | null;
  readonly loading: boolean;
  readonly filteredAnalysesCount: number;
}

// ── Helpers ────────────────────────────────────────────────

function modeColor(m: string): string {
  if (m === 'entry') return theme.accent;
  if (m === 'midday') return theme.caution;
  return '#A78BFA';
}

function formatDateLabel(d: string): string {
  try {
    const [year, month, day] = d.split('-').map(Number);
    const date = new Date(year!, month! - 1, day!);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return d;
  }
}

function dateCount(d: DateEntry, filter: ModeFilter): number {
  if (filter === 'entry') return d.entries;
  if (filter === 'midday') return d.middays;
  if (filter === 'review') return d.reviews;
  return d.total;
}

// ── Component ──────────────────────────────────────────────

export default function AnalysisHistoryPicker({
  modeFilter,
  onModeFilterChange,
  fetchError,
  filteredDates,
  selectedDate,
  onDateChange,
  availableTimes,
  selectedTime,
  onTimeChange,
  availableModes,
  selectedMode,
  onModeChange,
  runsAtTimeMode,
  selectedRunIndex,
  onRunIndexChange,
  selectedAnalysis,
  loading,
  filteredAnalysesCount,
}: Props) {
  return (
    <>
      {/* ── Mode filter tabs ──────────────────────────────── */}
      <div className="mb-4 flex gap-1.5">
        {(
          [
            ['all', 'All'],
            ['entry', 'Pre-Trade'],
            ['midday', 'Mid-Day'],
            ['review', 'Review'],
          ] as const
        ).map(([key, label]) => {
          const active = modeFilter === key;
          const color =
            key === 'all'
              ? theme.text
              : key === 'entry'
                ? theme.accent
                : key === 'midday'
                  ? theme.caution
                  : '#A78BFA';
          return (
            <button
              key={key}
              type="button"
              onClick={() => onModeFilterChange(key)}
              className="cursor-pointer rounded-full px-3 py-1.5 font-mono text-[10px] font-semibold transition-all duration-100"
              style={{
                backgroundColor: active ? tint(color, '15') : 'transparent',
                color: active ? color : theme.textMuted,
                border: `1.5px solid ${active ? color + '40' : theme.border}`,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {fetchError && <ErrorMsg>{fetchError}</ErrorMsg>}

      {/* ── Picker row ────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {/* Date picker */}
        <div className="min-w-[180px] flex-1">
          <label
            htmlFor="analysis-date-picker"
            className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase"
          >
            Date
          </label>
          <select
            id="analysis-date-picker"
            value={selectedDate}
            onChange={(e) => onDateChange(e.target.value)}
            className="bg-input border-edge-strong hover:border-edge-heavy w-full cursor-pointer appearance-none rounded-lg border-[1.5px] px-3 py-2 font-mono text-[12px] transition-[border-color] duration-150 outline-none"
            style={{ color: theme.text }}
          >
            <option value="">Select a date...</option>
            {filteredDates.map((d) => {
              const count = dateCount(d, modeFilter);
              return (
                <option key={d.date} value={d.date}>
                  {formatDateLabel(d.date)} ({count})
                </option>
              );
            })}
          </select>
        </div>

        {/* Time picker */}
        {selectedDate && availableTimes.length > 0 && (
          <div className="min-w-[140px]">
            <label
              htmlFor="analysis-time-picker"
              className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase"
            >
              Entry Time
            </label>
            <select
              id="analysis-time-picker"
              value={selectedTime}
              onChange={(e) => onTimeChange(e.target.value)}
              className="bg-input border-edge-strong hover:border-edge-heavy w-full cursor-pointer appearance-none rounded-lg border-[1.5px] px-3 py-2 font-mono text-[12px] transition-[border-color] duration-150 outline-none"
              style={{ color: theme.text }}
            >
              {availableTimes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Mode tabs */}
        {selectedTime && availableModes.length > 1 && (
          <fieldset className="m-0 border-0 p-0">
            <legend className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase">
              Type
            </legend>
            <div className="flex gap-1">
              {(['entry', 'midday', 'review'] as AnalysisMode[]).map((m) => {
                const available = availableModes.includes(m);
                const active = selectedMode === m;
                if (!available) return null;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      onModeChange(m);
                      onRunIndexChange(0);
                    }}
                    className="cursor-pointer rounded-md px-3 py-2 font-mono text-[10px] font-semibold transition-all duration-100"
                    style={{
                      backgroundColor: active
                        ? tint(modeColor(m), '18')
                        : 'transparent',
                      color: active ? modeColor(m) : theme.textMuted,
                      border: `1.5px solid ${active ? modeColor(m) + '40' : theme.border}`,
                    }}
                  >
                    {MODE_LABELS[m].label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {/* Run picker */}
        {runsAtTimeMode.length > 1 && (
          <fieldset className="m-0 border-0 p-0">
            <legend className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase">
              Run
            </legend>
            <div className="flex gap-1">
              {runsAtTimeMode.map((run, i) => {
                const active = selectedRunIndex === i;
                const color = modeColor(run.mode);
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => onRunIndexChange(i)}
                    className="cursor-pointer rounded-md px-3 py-2 font-mono text-[10px] font-semibold transition-all duration-100"
                    style={{
                      backgroundColor: active
                        ? tint(color, '18')
                        : 'transparent',
                      color: active ? color : theme.textMuted,
                      border: `1.5px solid ${active ? color + '40' : theme.border}`,
                    }}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
      </div>

      {/* ── Loading ───────────────────────────────────────── */}
      {loading && (
        <div
          className="rounded-lg px-3 py-4 text-center font-sans text-[11px]"
          style={{ color: theme.textMuted }}
        >
          Loading...
        </div>
      )}

      {/* ── Summary bar + results ─────────────────────────── */}
      {selectedAnalysis && !loading && (
        <AnalysisHistoryItem analysis={selectedAnalysis} />
      )}

      {/* ── Empty state ───────────────────────────────────── */}
      {selectedDate && !loading && filteredAnalysesCount === 0 && (
        <div
          className="rounded-lg px-3 py-4 text-center font-sans text-[11px]"
          style={{ color: theme.textMuted }}
        >
          No{' '}
          {modeFilter === 'all'
            ? ''
            : MODE_LABELS[modeFilter as AnalysisMode].label + ' '}
          analyses found for this date.
        </div>
      )}
    </>
  );
}
