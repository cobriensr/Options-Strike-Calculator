/**
 * PlaybookSection — renders Claude's auto-playbook payload at the top
 * of the PeriscopePanel when the latest scraper tick has produced a
 * complete `panel_payload` row.
 *
 * Phase 4b of docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md.
 *
 * Visual style mirrors the existing client-derived `TradePlanSection`:
 * regime + bias chips on top-right, SPOT line, LONG/SHORT TRIGGER rows,
 * gamma floor/ceiling/magnet, futures plan body, narrative footer.
 *
 * Distinct UX cues:
 *  - "CLAUDE" badge in the header so the user can tell at a glance
 *    whether they're looking at Claude's read or the deterministic
 *    client computation.
 *  - Staleness chip (green/yellow/red) based on minutes since the
 *    slot's `slotCapturedAt`. Surfaces the "no fresh tick" failure
 *    mode visually rather than letting the user act on stale data.
 *  - "Claude reading…" hint when `latestInProgress` is true — a newer
 *    slot is mid-flight and an updated payload will arrive within
 *    the 5–9 min Opus thinking budget.
 */

import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import type {
  PlaybookRow,
  PlaybookPanelPayload,
  UsePeriscopePlaybookReturn,
} from '../../hooks/usePeriscopePlaybook';

interface PlaybookSectionProps {
  playbook: UsePeriscopePlaybookReturn;
}

/** Compute minutes elapsed since `slotCapturedAt`. Bounded to [0, ∞). */
function minutesSinceSlot(slotCapturedAt: string): number {
  const slotMs = new Date(slotCapturedAt).getTime();
  if (!Number.isFinite(slotMs)) return Number.POSITIVE_INFINITY;
  const diffMin = (Date.now() - slotMs) / 60_000;
  return Math.max(diffMin, 0);
}

/** CT date (YYYY-MM-DD) of an ISO timestamp via Intl. */
function ctDateOf(iso: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(iso));
}

/** True when the slot's CT date is older than today's CT date. */
function isPriorSession(slotCapturedAt: string): boolean {
  const slotDate = ctDateOf(slotCapturedAt);
  const todayDate = ctDateOf(new Date().toISOString());
  return slotDate < todayDate;
}

/** Staleness threshold colors per spec — green <12 min, yellow 12-25, red >25. */
function stalenessColor(minutes: number): string {
  if (minutes < 12) return theme.green;
  if (minutes < 25) return theme.caution;
  return theme.red;
}

function StalenessChip({ slotCapturedAt }: { slotCapturedAt: string }) {
  // Prior-session slots (e.g. yesterday's debrief showing Tuesday
  // morning) shouldn't render a ticking "23h ago" red chip — that
  // implies the scraper has fallen behind when really the data is
  // intentionally yesterday's last read. Show a static muted "PRIOR
  // SESSION" badge so the user knows it's last session's data without
  // alarm bells.
  if (isPriorSession(slotCapturedAt)) {
    return (
      <span
        className="rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase"
        style={{
          color: theme.textMuted,
          backgroundColor: theme.chipBg,
        }}
        aria-label="Prior trading session"
      >
        prior session
      </span>
    );
  }

  const minutes = minutesSinceSlot(slotCapturedAt);
  const color = stalenessColor(minutes);
  const label =
    minutes < 1
      ? '< 1m'
      : minutes < 60
        ? `${Math.floor(minutes)}m ago`
        : `${(minutes / 60).toFixed(1)}h ago`;
  return (
    <span
      className="rounded px-1.5 py-0.5 font-mono text-[10px]"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
      aria-label={`Slot age ${label}`}
    >
      {label}
    </span>
  );
}

function fmtLevel(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(0);
}

function modeLabel(mode: PlaybookRow['mode']): string {
  if (mode === 'pre_trade') return 'PRE-TRADE';
  if (mode === 'debrief') return 'DEBRIEF';
  return 'INTRADAY';
}

/**
 * Header strip rendered above the playbook body. Carries the CLAUDE
 * badge, mode chip, staleness chip, and in-progress hint.
 */
function PlaybookHeader({
  row,
  latestInProgress,
}: {
  row: PlaybookRow;
  latestInProgress: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px]">
      <span
        className="rounded px-1.5 py-0.5 font-mono tracking-wider uppercase"
        style={{
          color: theme.accent,
          backgroundColor: theme.accentBg,
        }}
      >
        Claude
      </span>
      <span
        className="rounded px-1.5 py-0.5 font-mono tracking-wider uppercase"
        style={{
          color: theme.text,
          backgroundColor: theme.chipBg,
        }}
      >
        {modeLabel(row.mode)}
      </span>
      <StalenessChip slotCapturedAt={row.slotCapturedAt} />
      <span
        className="font-mono text-[10px]"
        style={{ color: theme.textMuted }}
      >
        slot {formatTimeCT(row.slotCapturedAt)} CT
      </span>
      {latestInProgress && (
        <span
          className="rounded px-1.5 py-0.5 font-mono tracking-wider uppercase"
          style={{
            color: theme.caution,
            backgroundColor: `color-mix(in srgb, ${theme.caution} 15%, transparent)`,
          }}
          aria-label="Newer slot Claude is reading"
        >
          ⚡ Claude reading newer slot…
        </span>
      )}
    </div>
  );
}

/**
 * Triggers + regime row. Mirrors the row shape from the deterministic
 * TradePlanSection so the muscle memory transfers.
 */
function TriggersRow({ payload }: { payload: PlaybookPanelPayload }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="SPOT" value={fmtLevel(payload.spot)} />
      <Stat
        label="REGIME"
        value={payload.regime ?? '—'}
        valueColor={theme.text}
      />
      <Stat
        label="LONG TRIGGER"
        value={fmtLevel(payload.longTrigger)}
        valueColor={theme.green}
      />
      <Stat
        label="SHORT TRIGGER"
        value={fmtLevel(payload.shortTrigger)}
        valueColor={theme.red}
      />
    </div>
  );
}

function GammaRow({ payload }: { payload: PlaybookPanelPayload }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat
        label="Γ FLOOR"
        value={fmtLevel(payload.gammaFloor)}
        valueColor={theme.green}
      />
      <Stat
        label="Γ CEILING"
        value={fmtLevel(payload.gammaCeiling)}
        valueColor={theme.red}
      />
      <Stat label="MAGNET" value={fmtLevel(payload.magnet)} />
      <Stat label="CHARM ZERO" value={fmtLevel(payload.charmZero)} />
    </div>
  );
}

function Stat({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className="font-sans text-[9px] font-bold tracking-[0.12em] uppercase"
        style={{ color: theme.textTertiary }}
      >
        {label}
      </span>
      <span
        className="font-mono text-[14px]"
        style={{ color: valueColor ?? theme.text }}
      >
        {value}
      </span>
    </div>
  );
}

function StructuresRow({ payload }: { payload: PlaybookPanelPayload }) {
  if (payload.recommended.length === 0 && payload.avoid.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {payload.recommended.length > 0 && (
        <ChipList
          label="RECOMMENDED"
          items={payload.recommended}
          color={theme.green}
        />
      )}
      {payload.avoid.length > 0 && (
        <ChipList label="AVOID" items={payload.avoid} color={theme.red} />
      )}
    </div>
  );
}

function ChipList({
  label,
  items,
  color,
}: {
  label: string;
  items: string[];
  color: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className="font-sans text-[9px] font-bold tracking-[0.12em] uppercase"
        style={{ color: theme.textTertiary }}
      >
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item}
            className="rounded px-1.5 py-0.5 font-mono text-[11px]"
            style={{
              color,
              backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
            }}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function FuturesPlanBlock({ plan }: { plan: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className="font-sans text-[9px] font-bold tracking-[0.12em] uppercase"
        style={{ color: theme.textTertiary }}
      >
        Futures Plan
      </span>
      <pre
        className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
        style={{ color: theme.textSecondary }}
      >
        {plan}
      </pre>
    </div>
  );
}

/**
 * Concise italic line. Reserved for SHORT summaries (≤ 200 chars).
 * Long structured prose uses `LabeledProseBlock` below — italics at
 * small font are unreadable beyond a couple sentences. The lessons
 * (2026-05-11) made `confidenceBasis` and `expectedDealerBehavior`
 * multi-sentence prose; gating on length keeps each rendering style
 * matched to its content.
 */
function ItalicSummaryLine({ text }: { text: string | null }) {
  if (!text || text.trim() === '') return null;
  return (
    <p
      className="font-mono text-[11px] leading-snug italic"
      style={{ color: theme.textSecondary }}
    >
      {text}
    </p>
  );
}

/**
 * Labeled, non-italic, paragraph-friendly prose block for the richer
 * fields that Claude now writes under the IF-THEN / disqualifier /
 * flow-structure-check lessons. Mirrors `FuturesPlanBlock` shape so
 * the visual rhythm stays consistent.
 */
function LabeledProseBlock({
  label,
  text,
}: {
  label: string;
  text: string | null;
}) {
  if (!text || text.trim() === '') return null;
  return (
    <div className="flex flex-col gap-1">
      <span
        className="font-sans text-[9px] font-bold tracking-[0.12em] uppercase"
        style={{ color: theme.textTertiary }}
      >
        {label}
      </span>
      <p
        className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
        style={{ color: theme.textSecondary }}
      >
        {text}
      </p>
    </div>
  );
}

/**
 * Choose the right renderer based on text length. Short summary
 * fits in an italic 1-liner; multi-sentence prose gets a labeled
 * paragraph block.
 */
function ProseField({
  label,
  text,
  longThreshold = 200,
}: {
  label: string;
  text: string | null;
  longThreshold?: number;
}) {
  if (!text || text.trim() === '') return null;
  if (text.length <= longThreshold) return <ItalicSummaryLine text={text} />;
  return <LabeledProseBlock label={label} text={text} />;
}

/** Empty-state body when no playbook has been produced for the picked date. */
function PlaybookEmpty({ inProgress }: { inProgress: boolean }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border p-3"
      style={{
        borderColor: theme.border,
        backgroundColor: theme.surfaceAlt,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase"
          style={{
            color: theme.accent,
            backgroundColor: theme.accentBg,
          }}
        >
          Claude
        </span>
        <span
          className="font-mono text-[10px]"
          style={{ color: theme.textMuted }}
        >
          {inProgress
            ? 'reading the first slot of the day…'
            : 'waiting for first scraper tick of the day'}
        </span>
      </div>
    </div>
  );
}

export function PlaybookSection({ playbook }: PlaybookSectionProps) {
  // Hook produced an error — let the caller fall through to the
  // deterministic render. Don't show a broken playbook box.
  if (playbook.error != null) return null;

  const row = playbook.data;
  if (row == null || row.panelPayload == null) {
    // No completed row yet for this date. Show a small in-progress hint
    // when the scraper has fired and Claude is reading; otherwise show
    // a "waiting for first tick" hint. Either way, return non-null so
    // the panel still surfaces Claude as a section, not just the
    // deterministic block.
    return <PlaybookEmpty inProgress={playbook.latestInProgress} />;
  }

  const payload = row.panelPayload;

  return (
    <div
      className="flex flex-col gap-3 rounded-md border p-3"
      style={{
        borderColor: theme.border,
        backgroundColor: theme.surfaceAlt,
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3
          className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
          style={{ color: theme.textTertiary }}
        >
          Claude Playbook
        </h3>
        <PlaybookHeader
          row={row}
          latestInProgress={playbook.latestInProgress}
        />
      </div>

      <TriggersRow payload={payload} />

      {/* Top: confidence_basis. Italic 1-liner when short, labeled
          paragraph block when the new lessons (2026-05-11) produce
          multi-sentence basis prose. */}
      <ProseField label="Confidence Basis" text={payload.confidenceBasis} />

      {payload.bias != null && (
        <div className="flex items-center gap-2 text-[11px]">
          <span style={{ color: theme.textTertiary }}>BIAS</span>
          <span
            className="rounded px-1.5 py-0.5 font-mono uppercase"
            style={{
              color: theme.text,
              backgroundColor: theme.chipBg,
            }}
          >
            {payload.bias}
          </span>
          {payload.confidence != null && (
            <>
              <span style={{ color: theme.textTertiary }}>·</span>
              <span style={{ color: theme.textMuted }}>
                {payload.confidence} confidence
              </span>
            </>
          )}
        </div>
      )}

      <StructuresRow payload={payload} />

      {payload.futuresPlan != null && payload.futuresPlan.trim() !== '' && (
        <FuturesPlanBlock plan={payload.futuresPlan} />
      )}

      <GammaRow payload={payload} />

      {/* Bottom: expected_dealer_behavior. Italic line when terse,
          labeled paragraph block when the new lessons produce a
          multi-sentence FLOW-STRUCTURE CHECK. The full prose narrative
          is intentionally NOT rendered in the panel — it lives in
          prose_text for full debrief reads. */}
      <ProseField
        label="Dealer Behavior"
        text={payload.expectedDealerBehavior}
      />
    </div>
  );
}
