/**
 * PeriscopePanel — read-only display of the latest Periscope exposure
 * map, served by `/api/periscope-map` from GEXBot's 1-min state captures.
 * The title names the slice's feed: UW Periscope (market-maker position
 * estimate) before the 2026-05-26 cutover, GEXBot (taker-side sign)
 * after; neutral while there is no slice.
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
 *
 * After the close the live route holds the last session's map: the section
 * header then carries the shared CLOSED badge ("CLOSED · as of Fri 3:00 PM
 * CT") beside the slot picker, the body header keeps its in-session "Slot
 * 3:00 PM CT · <expiry>" form, and the slot list is that session's. A picked
 * slot is a past slice by choice and never gets the badge, nor does an error
 * body.
 */

import { memo } from 'react';
import { ClosedBadge, SectionBox } from '../ui';
import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import { getCTTime } from '../../utils/timezone';
import type {
  PeriscopeView,
  PeriscopeSelectedSlot,
} from '../../hooks/usePeriscopeExposure';
import { MMExposureMap } from './MMExposureMap';
import { SlotPicker } from './SlotPicker';
import { periscopeSourceAt } from '../../utils/periscope-source';

/** Section title by the displayed slice's feed (owner decision D1 revised). */
const PANEL_TITLE = {
  scraper: 'Periscope MM Exposure (UW)',
  gexbot: 'GEXBot Exposure (taker)',
  unknown: 'Periscope Exposure',
} as const;

interface PeriscopePanelProps {
  /** Regular session open (App's `liveMarketOpen`). When false, the live
   *  route's view is the last session's, and the header says so. */
  marketOpen: boolean;
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
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const ct = getCTTime(d);
  return `${String(ct.hour).padStart(2, '0')}:${String(ct.minute).padStart(2, '0')}`;
}

/**
 * Convert an ISO captured_at to a CT YYYY-MM-DD string, or '' when it does
 * not parse (Intl's format() throws on an invalid Date, which would take
 * the panel down; the map then shows its unknown-source state).
 */
function isoToCtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const ctDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return ctDate.format(d);
}

function PeriscopePanelInner({
  marketOpen,
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

  const source = view == null ? null : periscopeSourceAt(view.capturedAt);

  // The live route after the close holds the last session's map. A picked slot
  // is a past slice by choice, never "the close", and a held view over an error
  // body (a picked slot's, while the live route fails) is not the close either.
  const showClosedBadge =
    isLive && !marketOpen && view != null && error == null;

  return (
    <SectionBox
      label={PANEL_TITLE[source ?? 'unknown']}
      headerRight={
        // SectionBox's header row has only a row gap, so the badge and the
        // picker get their own spaced, wrapping, right-aligned row.
        <div className="flex flex-wrap items-center justify-end gap-2">
          {showClosedBadge && (
            <ClosedBadge
              asOf={view.capturedAt}
              testId="periscope-closed-badge"
            />
          )}
          <SlotPicker
            displayedDate={displayedDate}
            displayedTime={displayedTime}
            availableSlots={availableSlots}
            currentSlotIso={currentSlotIso}
            currentIdx={currentIdx}
            canPrev={canPrev}
            canNext={canNext}
            isLive={isLive}
            marketOpen={marketOpen}
            asOf={asOf}
            loading={loading}
            onSelectSlot={onSelectSlot}
            onRefresh={onRefresh}
            stepTo={stepTo}
          />
        </div>
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
