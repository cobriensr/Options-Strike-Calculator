/**
 * PeriscopePanel — read-only display of the latest dealer-flow map,
 * served by `/api/periscope-map` from GEXBot's 1-min state captures.
 *
 * The panel is a thin composition shell: header (slot timestamp + spot)
 * plus the deterministic `MMExposureMap` body that derives the level
 * ladder, entry triggers, stops, targets, and recommended options
 * structures from the PeriscopeView. SlotPicker provides the date/time
 * stepper that swaps the data source to `/api/periscope-exposure` for
 * historical replay (full ~6-month back-catalog from periscope_snapshots).
 *
 * Empty states are explicit: "no SPX spot yet" or "no GEXBot capture
 * for today yet" — never a blank panel.
 */

import { memo } from 'react';
import { SectionBox } from '../ui';
import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import { getCTTime } from '../../utils/timezone';
import type {
  PeriscopeView,
  PeriscopeSelectedSlot,
} from '../../hooks/usePeriscopeExposure';
import { MMExposureMap } from './MMExposureMap';
import { SlotPicker } from './SlotPicker';

interface PeriscopePanelProps {
  view: PeriscopeView | null;
  emptyReason: 'no_spot' | 'no_slot' | null;
  asOf: string | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** ISO captured_at timestamps for the picked date, ascending. */
  availableSlots: string[];
  /** Selected slot (date+time CT) — null = follow live. */
  selectedSlot: PeriscopeSelectedSlot | null;
  /** Callback to change the selected slot. Pass null to drop back to live. */
  onSelectSlot: (slot: PeriscopeSelectedSlot | null) => void;
}

/** Convert an ISO captured_at to a CT HH:MM string (zero-padded).
 *  Used for both display (slot label) and the selectedSlot.time round-trip
 *  when the user clicks prev/next. */
function isoToCtTime(iso: string): string {
  const ct = getCTTime(new Date(iso));
  return `${String(ct.hour).padStart(2, '0')}:${String(ct.minute).padStart(2, '0')}`;
}

/** Convert an ISO captured_at to a CT YYYY-MM-DD string. */
function isoToCtDate(iso: string): string {
  const ctDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return ctDate.format(new Date(iso));
}

function PeriscopePanelInner({
  view,
  emptyReason,
  asOf,
  loading,
  error,
  onRefresh,
  availableSlots,
  selectedSlot,
  onSelectSlot,
}: PeriscopePanelProps) {
  // Resolve the displayed slot's CT timestamps. When the rendered view
  // exists, prefer its captured_at (ground truth). Otherwise fall back
  // to the user's selectedSlot (so the picker still reflects the picked
  // value during empty-state). Last resort: today's CT date for the
  // date input.
  const displayedDate =
    selectedSlot?.date ??
    (view != null
      ? isoToCtDate(view.capturedAt)
      : isoToCtDate(new Date().toISOString()));
  const displayedTime =
    selectedSlot?.time ?? (view != null ? isoToCtTime(view.capturedAt) : '');

  // Step navigation index within availableSlots — uses the rendered
  // capturedAt so prev/next is anchored to actual data, not to a picker
  // value the user might have set to a slot that doesn't exist.
  const currentSlotIso = view?.capturedAt;
  const currentIdx =
    currentSlotIso != null ? availableSlots.indexOf(currentSlotIso) : -1;
  const canPrev = currentIdx > 0;
  const canNext = currentIdx >= 0 && currentIdx < availableSlots.length - 1;

  const stepTo = (iso: string) => {
    onSelectSlot({ date: isoToCtDate(iso), time: isoToCtTime(iso) });
  };

  const isLive = selectedSlot == null;

  let body: React.ReactNode;
  if (error) {
    body = (
      <p className="font-mono text-[12px]" style={{ color: theme.red }}>
        {error}
      </p>
    );
  } else if (view == null) {
    const message =
      emptyReason === 'no_spot'
        ? 'Waiting for SPX spot from index_candles_1m.'
        : 'No GEXBot capture for today yet. First slot lands around the cash open (8:30 CT).';
    body = (
      <p className="font-mono text-[12px]" style={{ color: theme.textMuted }}>
        {message}
      </p>
    );
  } else {
    body = <PeriscopeBody view={view} />;
  }

  return (
    <SectionBox
      label="Periscope MM Exposure"
      headerRight={
        <SlotPicker
          displayedDate={displayedDate}
          displayedTime={displayedTime}
          availableSlots={availableSlots}
          currentSlotIso={currentSlotIso}
          currentIdx={currentIdx}
          canPrev={canPrev}
          canNext={canNext}
          isLive={isLive}
          asOf={asOf}
          loading={loading}
          onSelectSlot={onSelectSlot}
          onRefresh={onRefresh}
          stepTo={stepTo}
        />
      }
      collapsible
    >
      {body}
    </SectionBox>
  );
}

function PeriscopeBody({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between font-mono text-[11px]">
        <span style={{ color: theme.textSecondary }}>
          Slot {formatTimeCT(view.capturedAt)} CT · {view.expiry}
        </span>
        <span style={{ color: theme.text }}>spot {view.spot.toFixed(2)}</span>
      </div>

      <MMExposureMap view={view} />
    </div>
  );
}

export const PeriscopePanel = memo(PeriscopePanelInner);
