/**
 * TRACELiveControls — date picker + timestamp dropdown.
 *
 * Live mode (today + selectedId === null) hides the timestamp dropdown
 * since the hook auto-follows the latest row. Historical mode (past date
 * OR explicit id selection) reveals the dropdown so the user can scrub
 * back through every recorded capture for the chosen day.
 */

import { memo, useMemo } from 'react';
import { theme } from '../../themes';
import type { TraceLiveSummary } from './types';

interface Props {
  readonly list: TraceLiveSummary[];
  readonly listLoading: boolean;
  readonly listError: string | null;
  readonly selectedDate: string;
  readonly onDateChange: (d: string) => void;
  readonly selectedId: number | null;
  readonly onSelectId: (id: number | null) => void;
  readonly isLive: boolean;
}

function formatTimeLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function TRACELiveControls({
  list,
  listLoading,
  listError,
  selectedDate,
  onDateChange,
  selectedId,
  onSelectId,
  isLive,
}: Readonly<Props>) {
  // Sort list newest-first for the dropdown so the most recent capture
  // appears at the top — matches user mental model when scrubbing back.
  const sortedList = useMemo(
    () => [...list].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
    [list],
  );

  return (
    <div className="border-edge mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
      <label className="text-muted flex items-center gap-2 text-[11px]">
        <span>Date:</span>
        <input
          type="date"
          className="bg-surface-alt border-edge text-primary rounded border px-2 py-1 font-mono text-[11px]"
          value={selectedDate}
          onChange={(e) => onDateChange(e.target.value)}
          aria-label="Select trading day"
        />
      </label>

      <label className="text-muted flex items-center gap-2 text-[11px]">
        <span>Capture:</span>
        <select
          className="bg-surface-alt border-edge text-primary min-w-[160px] rounded border px-2 py-1 font-mono text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
          value={selectedId == null ? '' : String(selectedId)}
          onChange={(e) => {
            const v = e.target.value;
            onSelectId(v === '' ? null : Number(v));
          }}
          disabled={sortedList.length === 0}
          aria-label="Select capture timestamp"
        >
          <option value="">
            {isLive ? 'Latest (live)' : 'Pick a timestamp'}
          </option>
          {sortedList.map((s) => (
            <option key={s.id} value={s.id}>
              {formatTimeLabel(s.capturedAt)} ET — {s.regime ?? 'n/a'}
              {s.overrideApplied ? ' • override' : ''}
            </option>
          ))}
        </select>
      </label>

      {listLoading && (
        <span className="text-muted text-[10px]" aria-live="polite">
          loading list…
        </span>
      )}

      {listError && (
        <span className="text-[10px]" style={{ color: theme.red }} role="alert">
          {listError}
        </span>
      )}

      {!listLoading && !listError && sortedList.length === 0 && (
        <span className="text-muted text-[10px]">
          No captures recorded for this date
        </span>
      )}
    </div>
  );
}

export default memo(TRACELiveControls);
