/**
 * Periscope slot picker — the header-right control cluster of
 * PeriscopePanel.
 *
 * Renders the date input, prev/next stepper, time-of-day dropdown,
 * "live" toggle, asOf label, and the manual refresh button. The
 * navigation/index math is owned by the parent (`PeriscopePanelInner`)
 * and passed in as props so this component stays a presentational unit.
 *
 * Extracted from PeriscopePanel.tsx during the Phase 3A decomposition
 * (2026-05-19) to keep the panel shell ≤250 LOC.
 */

import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import { getCTTime } from '../../utils/timezone';
import type { PeriscopeSelectedSlot } from '../../hooks/usePeriscopeExposure';

/** Convert an ISO captured_at to a CT HH:MM string (zero-padded). */
function isoToCtTime(iso: string): string {
  const ct = getCTTime(new Date(iso));
  return `${String(ct.hour).padStart(2, '0')}:${String(ct.minute).padStart(2, '0')}`;
}

interface SlotPickerProps {
  displayedDate: string;
  displayedTime: string;
  availableSlots: string[];
  currentSlotIso: string | undefined;
  currentIdx: number;
  canPrev: boolean;
  canNext: boolean;
  isLive: boolean;
  asOf: string | null;
  isLoading: boolean;
  onSelectSlot: (slot: PeriscopeSelectedSlot | null) => void;
  onRefresh: () => void;
  stepTo: (iso: string) => void;
}

export function SlotPicker({
  displayedDate,
  displayedTime,
  availableSlots,
  currentSlotIso,
  currentIdx,
  canPrev,
  canNext,
  isLive,
  asOf,
  isLoading,
  onSelectSlot,
  onRefresh,
  stepTo,
}: SlotPickerProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        value={displayedDate}
        onChange={(e) => {
          const newDate = e.target.value;
          if (!newDate) return;
          // When changing date, jump to that date's last slot via end-of-day
          // (backend resolves to latest slot at-or-before 23:59 CT for the
          // picked date).
          onSelectSlot({ date: newDate, time: '23:59' });
        }}
        className="rounded border px-1.5 py-0.5 font-mono text-[10px]"
        style={{
          backgroundColor: theme.surfaceAlt,
          borderColor: theme.border,
          color: theme.text,
        }}
        aria-label="Periscope slot date"
      />
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            if (canPrev) stepTo(availableSlots[currentIdx - 1]!);
          }}
          disabled={!canPrev}
          className="rounded px-1.5 py-0.5 font-mono text-[10px] disabled:opacity-30"
          style={{ color: theme.text, backgroundColor: theme.chipBg }}
          aria-label="Previous slot"
        >
          ‹
        </button>
        {/* Slot dropdown lets the user jump anywhere in the day's
            available scrapes without stepping ±10 min at a time. The
            `‹›` buttons remain for fine adjustment. When the rendered
            view is not yet anchored to an availableSlots entry (e.g.,
            empty-state with no data), fall back to a single placeholder
            option so the select still renders a valid value. */}
        <select
          value={currentSlotIso ?? ''}
          onChange={(e) => {
            if (e.target.value) stepTo(e.target.value);
          }}
          disabled={availableSlots.length === 0}
          className="rounded border px-1 py-0.5 font-mono text-[10px] disabled:opacity-30"
          style={{
            backgroundColor: theme.surfaceAlt,
            borderColor: theme.border,
            color: theme.text,
            minWidth: '60px',
          }}
          aria-label="Periscope slot time"
        >
          {currentSlotIso == null && (
            <option value="" disabled>
              {displayedTime || '—'}
            </option>
          )}
          {availableSlots.map((iso) => (
            <option key={iso} value={iso}>
              {isoToCtTime(iso)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            if (canNext) stepTo(availableSlots[currentIdx + 1]!);
          }}
          disabled={!canNext}
          className="rounded px-1.5 py-0.5 font-mono text-[10px] disabled:opacity-30"
          style={{ color: theme.text, backgroundColor: theme.chipBg }}
          aria-label="Next slot"
        >
          ›
        </button>
      </div>
      <button
        type="button"
        onClick={() => onSelectSlot(null)}
        disabled={isLive}
        className="rounded px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase disabled:opacity-50"
        style={{
          color: isLive ? theme.green : theme.text,
          backgroundColor: isLive ? theme.accentBg : theme.chipBg,
        }}
        aria-label="Return to live"
      >
        {isLive ? '● live' : 'live'}
      </button>
      {asOf && isLive && (
        <span
          className="font-mono text-[10px]"
          style={{ color: theme.textMuted }}
        >
          {formatTimeCT(asOf, { fallback: '' })} CT
        </span>
      )}
      <button
        type="button"
        onClick={onRefresh}
        disabled={isLoading}
        className="rounded px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase disabled:opacity-50"
        style={{
          color: theme.accent,
          backgroundColor: theme.accentBg,
        }}
      >
        {isLoading ? '…' : 'refresh'}
      </button>
    </div>
  );
}
