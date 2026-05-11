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
 */

import { memo, useMemo } from 'react';
import { SectionBox } from '../ui';
import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import { getCTTime } from '../../utils/timezone';
import type {
  PeriscopeView,
  RankedRow,
  RankedRowSimple,
  PeriscopeSelectedSlot,
} from '../../hooks/usePeriscopeExposure';
import {
  computeTradePlan,
  type TradePlan,
  type Verdict,
} from '../../utils/periscope-trade-plan';
import type { UsePeriscopePlaybookReturn } from '../../hooks/usePeriscopePlaybook';
import { PlaybookSection } from './PlaybookSection';

interface PeriscopePanelProps {
  view: PeriscopeView | null;
  emptyReason: 'no_spot' | 'no_slot' | null;
  asOf: string | null;
  isLoading: boolean;
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

function fmtSigned(n: number): string {
  if (Math.abs(n) >= 1_000_000)
    return `${n >= 0 ? '+' : ''}${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000)
    return `${n >= 0 ? '+' : ''}${(n / 1_000).toFixed(1)}K`;
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}`;
}

function fmtPts(pts: number): string {
  const sign = pts >= 0 ? '+' : '';
  return `${sign}${pts.toFixed(0)}`;
}

function colorForValue(v: number): string {
  if (v > 0) return theme.green;
  if (v < 0) return theme.red;
  return theme.textSecondary;
}

function RankedCell({ row }: { row: RankedRow | RankedRowSimple }) {
  const ptsLabel = 'ptsFromSpot' in row ? ` (${fmtPts(row.ptsFromSpot)})` : '';
  return (
    <span className="font-mono text-[12px]">
      <span style={{ color: theme.text }}>{row.strike}</span>{' '}
      <span style={{ color: colorForValue(row.value) }}>
        {fmtSigned(row.value)}
      </span>
      {ptsLabel && <span style={{ color: theme.textMuted }}>{ptsLabel}</span>}
    </span>
  );
}

function asymmetryLabel(pts: number): string {
  if (pts > 0) return 'lower-skewed (downside priced richer)';
  if (pts < 0) return 'upper-skewed (upside priced richer)';
  return 'symmetric';
}

function PeriscopePanelInner({
  view,
  emptyReason,
  asOf,
  isLoading,
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

  const headerRight = (
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
      headerRight={headerRight}
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
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between font-mono text-[11px]">
        <span style={{ color: theme.textSecondary }}>
          Slot {formatTimeCT(view.capturedAt)} CT · {view.expiry}
        </span>
        <span style={{ color: theme.text }}>spot {view.spot.toFixed(2)}</span>
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
      {view.signFlips.length > 0 && <SignFlipsSection view={view} />}
    </div>
  );
}

function verdictColor(v: Verdict): string {
  if (v === 'safe') return theme.green;
  if (v === 'conditional') return theme.caution;
  return theme.red;
}

function regimeColor(regime: TradePlan['regime']): string {
  if (regime === 'cone-breach-up') return theme.green;
  if (regime === 'cone-breach-down') return theme.red;
  if (regime === 'pin') return theme.accent;
  if (regime === 'drift-and-cap') return theme.text;
  return theme.textMuted;
}

function fmtLevel(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(0);
}

function TradePlanSection({ plan }: { plan: TradePlan }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border p-3"
      style={{
        borderColor: theme.border,
        backgroundColor: theme.surfaceAlt,
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3
          className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
          style={{ color: theme.textTertiary }}
        >
          Trade Plan
        </h3>
        <div className="flex items-center gap-2 font-mono text-[10px]">
          <span
            className="rounded px-1.5 py-0.5 tracking-wider uppercase"
            style={{
              color: regimeColor(plan.regime),
              backgroundColor: `color-mix(in srgb, ${regimeColor(plan.regime)} 15%, transparent)`,
            }}
          >
            {plan.regime}
          </span>
          <span
            className="rounded px-1.5 py-0.5 tracking-wider uppercase"
            style={{
              color: theme.text,
              backgroundColor: theme.chipBg,
            }}
          >
            bias: {plan.bias}
          </span>
        </div>
      </div>

      <p
        className="font-mono text-[11px] leading-snug"
        style={{ color: theme.textSecondary }}
      >
        {plan.summary}
      </p>

      <DirectionalRow label="LONG" plan={plan.long} />
      <DirectionalRow label="SHORT" plan={plan.short} />

      {plan.waitZone != null && (
        <div className="flex items-baseline gap-2 font-mono text-[11px]">
          <span className="font-bold" style={{ color: theme.textTertiary }}>
            WAIT
          </span>
          <span style={{ color: theme.textMuted }}>{plan.waitZone}</span>
        </div>
      )}
    </div>
  );
}

function DirectionalRow({
  label,
  plan,
}: {
  label: string;
  plan: TradePlan['long'];
}) {
  const color = verdictColor(plan.verdict);
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[11px]">
      <div className="flex items-baseline gap-2">
        <span className="font-bold" style={{ color: theme.text }}>
          {label}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px] tracking-wider uppercase"
          style={{
            color,
            backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
          }}
        >
          {plan.verdict}
        </span>
        {plan.verdict !== 'avoid' && (
          <span className="text-[10px]" style={{ color: theme.textSecondary }}>
            trigger {fmtLevel(plan.trigger)} · stop {fmtLevel(plan.stop)} ·
            target {fmtLevel(plan.target)}
          </span>
        )}
      </div>
      <span className="leading-snug" style={{ color: theme.textMuted }}>
        {plan.reason}
      </span>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
      style={{ color: theme.textTertiary }}
    >
      {children}
    </h3>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between">
      <span
        className="font-mono text-[11px]"
        style={{ color: theme.textSecondary }}
      >
        {label}
      </span>
      <span className="font-mono text-[12px]">{value}</span>
    </div>
  );
}

function ConeSection({ view }: { view: PeriscopeView }) {
  const cone = view.cone!;
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Straddle Cone</SectionHeader>
      <Row
        label="Bounds"
        value={
          <span style={{ color: theme.text }}>
            {cone.coneLower.toFixed(1)} — {cone.coneUpper.toFixed(1)} (
            {cone.coneWidth.toFixed(0)} pts)
          </span>
        }
      />
      <Row
        label="Asymmetry"
        value={
          <span style={{ color: theme.text }}>
            {fmtSigned(cone.asymmetryPts)} pts ·{' '}
            <span style={{ color: theme.textMuted }}>
              {asymmetryLabel(cone.asymmetryPts)}
            </span>
          </span>
        }
      />
      {view.breaches.length === 0 ? (
        <Row
          label="Breach"
          value={
            <span style={{ color: theme.textSecondary }}>
              none — {(cone.coneUpper - view.spot).toFixed(0)} pts to upper,{' '}
              {(view.spot - cone.coneLower).toFixed(0)} pts to lower
            </span>
          }
        />
      ) : (
        view.breaches.map((b) => (
          <Row
            key={`${b.direction}-${b.breachTime}`}
            label={`${b.direction.toUpperCase()} breach`}
            value={
              <span style={{ color: theme.caution }}>
                {formatTimeCT(b.breachTime)} CT · spot{' '}
                {b.spotAtBreach.toFixed(2)} ({fmtSigned(b.ptsPastBound)} pts
                past)
              </span>
            }
          />
        ))
      )}
    </div>
  );
}

function GammaSection({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Gamma Topology</SectionHeader>
      <Row
        label="+γ ceiling"
        value={
          view.gamma.ceiling ? (
            <RankedCell row={view.gamma.ceiling} />
          ) : (
            <span style={{ color: theme.textMuted }}>none ±100</span>
          )
        }
      />
      <Row
        label="+γ floor"
        value={
          view.gamma.floor ? (
            <RankedCell row={view.gamma.floor} />
          ) : (
            <span style={{ color: theme.textMuted }}>none ±100</span>
          )
        }
      />
      <Row
        label="−γ accel (top 3)"
        value={
          view.gamma.accelTop.length > 0 ? (
            <span className="flex flex-wrap justify-end gap-x-3">
              {view.gamma.accelTop.map((r) => (
                <RankedCell key={r.strike} row={r} />
              ))}
            </span>
          ) : (
            <span style={{ color: theme.textMuted }}>none</span>
          )
        }
      />
    </div>
  );
}

/** Charm-tally magnitude under which we treat the tally as "noise" rather
 *  than directional drift. Matches the threshold used by computeTradePlan. */
const CHARM_DRIFT_NOISE_THRESHOLD = 1_000_000;

interface CharmDriftRead {
  position: { text: string; color: string };
  drift: { text: string; color: string };
  weight: { text: string; color: string };
}

function computeCharmDriftRead(args: {
  spot: number;
  charmZeroStrike: number;
  tallyWide100: number;
  capturedAt: string;
}): CharmDriftRead {
  const { spot, charmZeroStrike, tallyWide100, capturedAt } = args;

  const distance = spot - charmZeroStrike;
  const absDist = Math.abs(distance);
  let positionText: string;
  if (absDist < 1) {
    positionText = `Spot pinned at charm-zero (${charmZeroStrike})`;
  } else if (distance > 0) {
    positionText = `Spot ${absDist.toFixed(0)} pts above charm-zero (${charmZeroStrike})`;
  } else {
    positionText = `Spot ${absDist.toFixed(0)} pts below charm-zero (${charmZeroStrike})`;
  }

  // Time-of-day weight class. The skill's framework: charm is a function
  // of time-to-expiry — its hedging force grows non-linearly through the
  // session and dominates the final 90 minutes. Buckets match the
  // user's 5-phase intraday schedule.
  const ct = getCTTime(new Date(capturedAt));
  const minutes = ct.hour * 60 + ct.minute;
  const isPostClose = minutes >= 15 * 60;

  let driftText: string;
  let driftColor: string;
  if (isPostClose) {
    // Post-close slots freeze on a terminal/expiry charm value that no
    // longer predicts intraday drift — surface that instead of the
    // active "drift up/down" line that would otherwise be misleading.
    driftText = `Tally ${fmtSigned(tallyWide100)} → aftermarket reading, not applicable to intraday price movement`;
    driftColor = theme.textMuted;
  } else if (Math.abs(tallyWide100) < CHARM_DRIFT_NOISE_THRESHOLD) {
    driftText = `Tally ${fmtSigned(tallyWide100)} → flat, no mechanical drift`;
    driftColor = theme.textMuted;
  } else if (tallyWide100 >= 0) {
    driftText = `Tally ${fmtSigned(tallyWide100)} → mechanical /ES BUY into close (drift up)`;
    driftColor = theme.green;
  } else {
    driftText = `Tally ${fmtSigned(tallyWide100)} → mechanical /ES SELL into close (drift down)`;
    driftColor = theme.red;
  }

  let weightText: string;
  let weightColor: string;
  if (minutes < 8 * 60 + 30) {
    weightText = 'Pre-market — charm impact minimal';
    weightColor = theme.textMuted;
  } else if (minutes < 10 * 60 + 30) {
    weightText = 'Morning — gamma dominates, charm light';
    weightColor = theme.textMuted;
  } else if (minutes < 13 * 60) {
    weightText = 'Midday — charm building, dual-force';
    weightColor = theme.textSecondary;
  } else if (minutes < 14 * 60 + 30) {
    weightText = 'Charm window — mechanical drift dominates';
    weightColor = theme.text;
  } else if (minutes < 15 * 60) {
    weightText = 'Final 30m — pin / acceleration';
    weightColor = theme.accent;
  } else {
    weightText = 'Post-close';
    weightColor = theme.textMuted;
  }

  return {
    position: { text: positionText, color: theme.textSecondary },
    drift: { text: driftText, color: driftColor },
    weight: { text: weightText, color: weightColor },
  };
}

function CharmDriftRead({ read }: { read: CharmDriftRead }) {
  return (
    <div className="mt-1 flex flex-col gap-0.5 font-mono text-[11px]">
      <div style={{ color: read.position.color }}>{read.position.text}</div>
      <div style={{ color: read.drift.color }}>{read.drift.text}</div>
      <div style={{ color: read.weight.color }}>{read.weight.text}</div>
    </div>
  );
}

function CharmSection({ view }: { view: PeriscopeView }) {
  const driftRead =
    view.charm.charmZeroStrike != null
      ? computeCharmDriftRead({
          spot: view.spot,
          charmZeroStrike: view.charm.charmZeroStrike,
          tallyWide100: view.charm.tallyWide100,
          capturedAt: view.capturedAt,
        })
      : null;

  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Charm Flow</SectionHeader>
      <Row
        label="Net tally ±50"
        value={
          <span style={{ color: colorForValue(view.charm.tallyNear50) }}>
            {fmtSigned(view.charm.tallyNear50)}
          </span>
        }
      />
      <Row
        label="Net tally ±100"
        value={
          <span style={{ color: colorForValue(view.charm.tallyWide100) }}>
            {fmtSigned(view.charm.tallyWide100)}
          </span>
        }
      />
      {view.charm.topByAbs.length > 0 && (
        <Row
          label="Top |charm|"
          value={
            <span className="flex flex-wrap justify-end gap-x-3">
              {view.charm.topByAbs.map((r) => (
                <RankedCell key={r.strike} row={r} />
              ))}
            </span>
          }
        />
      )}
      {view.charm.charmZeroStrike != null && (
        <Row
          label="Charm-zero strike"
          value={
            <span style={{ color: theme.text }}>
              {view.charm.charmZeroStrike}
            </span>
          }
        />
      )}
      {driftRead && <CharmDriftRead read={driftRead} />}
    </div>
  );
}

function VannaSection({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Vanna Pressure</SectionHeader>
      <Row
        label="Top |vanna|"
        value={
          <span className="flex flex-wrap justify-end gap-x-3">
            {view.vanna.topByAbs.map((r) => (
              <RankedCell key={r.strike} row={r} />
            ))}
          </span>
        }
      />
    </div>
  );
}

function SignFlipsSection({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Sign Flips Since Prior Slice</SectionHeader>
      {view.signFlips.map((f) => (
        <div
          key={f.strike}
          className="flex items-baseline justify-between font-mono text-[11px]"
        >
          <span style={{ color: theme.textSecondary }}>{f.strike}</span>
          <span>
            <span style={{ color: colorForValue(f.from) }}>
              {fmtSigned(f.from)}
            </span>
            <span style={{ color: theme.textMuted }}> → </span>
            <span style={{ color: colorForValue(f.to) }}>
              {fmtSigned(f.to)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export const PeriscopePanel = memo(PeriscopePanelInner);
