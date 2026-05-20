/**
 * PeriscopePanel — read-only display of the latest UW Periscope
 * MM-attributed exposure slot, scraped into `periscope_snapshots`
 * by the Railway scraper service.
 *
 * Replaces the screenshot-paste workflow: the same data the analyze
 * endpoint injects into Claude's prompt is rendered here so the user
 * can see what Claude is seeing without opening UW.
 *
 * Sections (in priority order — matches the periscope skill's
 * structural read):
 *   1. Cone bounds + breach status  → frames the day's expected move
 *   2. Gamma topology               → +γ ceiling/floor + −γ accel
 *   3. Charm flow                   → tally near spot + top extremes
 *   4. Vanna pressure               → vol-shock sensitivity
 *   5. Sign flips                   → orange-bar regime-flip equivalent
 *
 * Empty states are explicit: "no SPX spot yet", "scraper hasn't
 * inserted any slot yet" — never a blank panel.
 *
 * As of Phase 3A (2026-05-19) this file is a thin composition shell —
 * the section components live in sibling files (ConeSection,
 * GammaSection, CharmSection, VannaSection, FlipsSection,
 * TradePlanSection, SlotPicker) and the shared formatters / UI
 * primitives live in `src/utils/periscope-formatting.ts` and
 * `./shared.tsx`.
 */

import { memo, useMemo } from 'react';
import { SectionBox } from '../ui';
import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import { getCTTime } from '../../utils/timezone';
import type {
  PeriscopeView,
  PeriscopeSelectedSlot,
} from '../../hooks/usePeriscopeExposure';
import { computeTradePlan } from '../../utils/periscope-trade-plan';
import type { UsePeriscopePlaybookReturn } from '../../hooks/usePeriscopePlaybook';
import { PlaybookSection } from './PlaybookSection';
import { TradePlanSection } from './TradePlanSection';
import { ConeSection } from './ConeSection';
import { GammaSection } from './GammaSection';
import { CharmSection } from './CharmSection';
import { VannaSection } from './VannaSection';
import { FlipsSection } from './FlipsSection';
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
  /**
   * Optional Claude-generated playbook. Rendered as the top section
   * when available with status='complete'. The deterministic TradePlan
   * section remains beneath as a fallback so the panel stays useful
   * when no auto-playbook row exists yet (Risk R14 in the spec).
   */
  playbook?: UsePeriscopePlaybookReturn | undefined;
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
  playbook,
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
        : 'Scraper has not inserted a Periscope slot for today yet. First slot lands ~5:50 CT during a normal session.';
    body = (
      <p className="font-mono text-[12px]" style={{ color: theme.textMuted }}>
        {message}
      </p>
    );
  } else {
    body = <PeriscopeBody view={view} playbook={playbook} />;
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

function PeriscopeBody({
  view,
  playbook,
}: {
  view: PeriscopeView;
  playbook?: UsePeriscopePlaybookReturn | undefined;
}) {
  const plan = useMemo(() => computeTradePlan(view), [view]);
  const hasClaudePlaybook =
    playbook?.data != null && playbook.data.panelPayload != null;

  // Spot reconciliation. Two sources can disagree:
  //   - `view.spot` is what UW's Periscope panel displayed at scrape
  //     time (recorded in periscope_snapshots).
  //   - `playbook.data.panelPayload.spot` is the DB-resolved SPX cash
  //     close at the slot's `read_time` (from index_candles_1m), per
  //     the 2026-05-11 runner override.
  // The DB cash value is the authoritative spot for analytical
  // purposes; the UW panel reading periodically drifts 20-50pt from
  // cash. When the playbook is present and the two diverge by >2pt,
  // show both labeled so the trader doesn't see a contradiction.
  // When agreement is tight or no playbook exists, show one value
  // (preferring playbook's cash spot when available).
  const playbookSpot = hasClaudePlaybook
    ? (playbook?.data?.panelPayload?.spot ?? null)
    : null;
  const showBothSpots =
    playbookSpot != null && Math.abs(view.spot - playbookSpot) > 2;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between font-mono text-[11px]">
        <span style={{ color: theme.textSecondary }}>
          Slot {formatTimeCT(view.capturedAt)} CT · {view.expiry}
        </span>
        {showBothSpots ? (
          <span style={{ color: theme.text }}>
            cash {playbookSpot!.toFixed(2)}
            <span style={{ color: theme.textMuted }}>
              {' '}
              · UW {view.spot.toFixed(2)}
            </span>
          </span>
        ) : (
          <span style={{ color: theme.text }}>
            spot {(playbookSpot ?? view.spot).toFixed(2)}
          </span>
        )}
      </div>

      {playbook != null && <PlaybookSection playbook={playbook} />}

      {/* Deterministic client-derived trade plan stays as a fallback /
          comparison surface — Risk R14 in the spec. Hidden visually when
          Claude's playbook is fresh to keep the panel concise. */}
      {!hasClaudePlaybook && <TradePlanSection plan={plan} />}

      {view.cone && <ConeSection view={view} />}
      <GammaSection view={view} />
      <CharmSection view={view} />
      {view.vanna.topByAbs.length > 0 && <VannaSection view={view} />}
      {view.signFlips.length > 0 && <FlipsSection view={view} />}
    </div>
  );
}

export const PeriscopePanel = memo(PeriscopePanelInner);
