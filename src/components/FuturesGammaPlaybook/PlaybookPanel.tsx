/**
 * PlaybookPanel — regime-reactive rules cheat sheet.
 *
 * Renders the rules produced by `rulesForRegime` as a compact table:
 * direction badge | condition text | entry | target | stop | distance |
 * status | sizing note.
 *
 * When the rule list is empty — either because the regime is STAND_ASIDE or
 * the session is outside RTH — the panel shows a single neutral "stand aside"
 * message explaining why, so the user isn't left wondering whether the panel
 * is broken.
 *
 * Pure presentational — no hooks, no side effects.
 */

import { memo } from 'react';
import type {
  PlaybookFlowSignals,
  PlaybookRule,
  RegimeVerdict,
  RuleConviction,
  RuleStatus,
  SessionPhase,
} from './types';
import { Tooltip } from '../ui/Tooltip';
import { TOOLTIP } from './copy/tooltips';
import { DRIFT_OVERRIDE_CONSISTENCY_MIN } from './playbook';

export interface PlaybookPanelProps {
  rules: PlaybookRule[];
  verdict: RegimeVerdict;
  phase: SessionPhase;
  /** Zero-gamma unavailable is a common cause of STAND_ASIDE; show it if so. */
  esZeroGammaKnown: boolean;
  /**
   * Live flow signals — when the priceTrend drifts consistently and the
   * opposing rule has been suppressed, we render a one-line note at the
   * top of the panel so the trader sees why.
   */
  flowSignals?: PlaybookFlowSignals;
}

// ── Presentation metadata ────────────────────────────────────────────

const DIRECTION_META: Record<
  PlaybookRule['direction'],
  { label: string; icon: string; className: string; title: string }
> = {
  LONG: {
    label: 'LONG',
    icon: '▲',
    className: 'bg-emerald-500/15 text-emerald-400',
    title: 'Long bias — enter from the bid side.',
  },
  SHORT: {
    label: 'SHORT',
    icon: '▼',
    className: 'bg-red-500/15 text-red-400',
    title: 'Short bias — enter from the offer side.',
  },
  EITHER: {
    label: 'EITHER',
    icon: '◆',
    className: 'bg-white/10 text-muted',
    title: 'Direction-agnostic — trade the level, not a side.',
  },
};

const CONVICTION_META: Record<
  RuleConviction,
  { label: string; icon: string; className: string; title: string } | null
> = {
  high: {
    label: 'HIGH',
    icon: '▲',
    className: 'bg-emerald-500/15 text-emerald-400',
    title:
      'High conviction: wall is a sticky-pin — charm strengthens the pin into the close.',
  },
  low: {
    label: 'LOW',
    icon: '▼',
    className: 'bg-amber-500/15 text-amber-400',
    title:
      'Low conviction: wall is a weakening-pin — charm drains through the session.',
  },
  // `standard` renders no badge to keep the row uncluttered.
  standard: null,
};

const STATUS_META: Record<
  RuleStatus,
  { label: string; className: string; title: string }
> = {
  ACTIVE: {
    label: 'ACTIVE',
    className: 'bg-sky-500/20 text-sky-300',
    title: 'Price is within proximity of the entry — act now.',
  },
  ARMED: {
    label: 'ARMED',
    className: 'bg-amber-500/20 text-amber-300',
    title: 'Price is within 15 pts of the entry — prepare.',
  },
  DISTANT: {
    label: 'DISTANT',
    className: 'bg-white/5 text-muted',
    title: 'Price is > 15 pts from the entry — wait.',
  },
  INVALIDATED: {
    label: 'INVALIDATED',
    className: 'bg-red-500/20 text-red-300',
    title:
      'Price has overshot the entry on the wrong side — do not take the trade.',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

function fmtEs(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

function fmtSignedPts(distance: number | null): string {
  if (distance === null) return '—';
  const rounded = Math.round(distance);
  if (rounded === 0) return '0 pts';
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded} pts`;
}

/**
 * Distance color-code: positive distance (price must rally to entry) →
 * green, negative distance (price must fall) → red. Muted when null.
 */
function distanceClass(distance: number | null): string {
  if (distance === null) return 'text-muted';
  if (distance > 0) return 'text-emerald-400';
  if (distance < 0) return 'text-red-400';
  return '';
}

function standAsideReason(
  verdict: RegimeVerdict,
  phase: SessionPhase,
  esZeroGammaKnown: boolean,
): string {
  if (phase === 'PRE_OPEN' || phase === 'POST_CLOSE') {
    return 'Outside RTH — SPX-derived ES levels are unreliable when cash is closed.';
  }
  if (!esZeroGammaKnown) {
    return 'Zero-gamma unavailable — waiting for a clean basis + strike ladder.';
  }
  if (verdict === 'STAND_ASIDE') {
    return 'Spot is inside the transition band around zero-gamma — no side has structural edge right now.';
  }
  return 'No active rules for the current regime and phase.';
}

// ── Component ─────────────────────────────────────────────────────────

const GRID_COLS =
  'grid-cols-[68px_1fr_72px_72px_72px_80px_96px_1fr]';

/**
 * Detect when the priceTrend is strong enough to have suppressed one of
 * the fade/lift rules. Returns the displayed direction (for the banner
 * copy) or null when no override was applied.
 *
 * Regime gate: fade/lift rules only exist in POSITIVE regime (verdict
 * === 'MEAN_REVERT'). If we're in NEGATIVE (TREND_FOLLOW) or
 * TRANSITIONING (STAND_ASIDE), the banner must stay dark — there's no
 * rule to suppress, so claiming suppression would be a user-facing
 * lie. Seen at 2:50 PM CT 2026-04-21 when regime had just flipped to
 * NEGATIVE but the banner still read "call-wall fade suppressed."
 */
function driftOverrideCopy(
  verdict: RegimeVerdict,
  flowSignals: PlaybookFlowSignals | undefined,
): { direction: 'up' | 'down'; suppressed: 'fade' | 'lift' } | null {
  if (verdict !== 'MEAN_REVERT') return null;
  const trend = flowSignals?.priceTrend;
  if (!trend) return null;
  if (trend.consistency < DRIFT_OVERRIDE_CONSISTENCY_MIN) return null;
  if (trend.direction === 'up') return { direction: 'up', suppressed: 'fade' };
  if (trend.direction === 'down') {
    return { direction: 'down', suppressed: 'lift' };
  }
  return null;
}

export const PlaybookPanel = memo(function PlaybookPanel({
  rules,
  verdict,
  phase,
  esZeroGammaKnown,
  flowSignals,
}: PlaybookPanelProps) {
  const override = driftOverrideCopy(verdict, flowSignals);
  if (rules.length === 0) {
    return (
      <div
        className="border-edge bg-surface-alt rounded-lg border p-4 text-center"
        aria-label="Playbook rules"
      >
        <div
          className="font-mono text-[12px] font-semibold tracking-wider uppercase"
          style={{ color: 'var(--color-tertiary)' }}
        >
          Stand aside — no setups active
        </div>
        <div
          className="mt-1 font-mono text-[11px]"
          style={{ color: 'var(--color-secondary)' }}
        >
          {standAsideReason(verdict, phase, esZeroGammaKnown)}
        </div>
      </div>
    );
  }

  return (
    <div
      className="border-edge bg-surface-alt rounded-lg border"
      aria-label="Playbook rules"
    >
      {/* Drift-override banner — surfaces when a fade/lift rule was
          suppressed because the tape is grinding through the dampener. */}
      {override && (
        <div
          className="border-edge border-b px-3 py-1.5 font-mono text-[11px]"
          style={{ color: 'var(--color-tertiary)' }}
          role="note"
          aria-label="Drift override note"
        >
          {override.direction === 'up'
            ? 'Drifting up — call-wall fade currently suppressed.'
            : 'Drifting down — put-wall lift currently suppressed.'}
        </div>
      )}

      {/* Header row */}
      <div
        className={`border-edge grid ${GRID_COLS} items-center gap-2 border-b px-3 py-1.5 font-mono text-[9px] font-semibold tracking-wider uppercase`}
        style={{ color: 'var(--color-tertiary)' }}
      >
        <span>Direction</span>
        <Tooltip content={TOOLTIP.playbookColumn.condition} side="bottom">
          <span className="cursor-help">Condition</span>
        </Tooltip>
        <Tooltip content={TOOLTIP.playbookColumn.entry} side="bottom">
          <span className="w-full cursor-help text-right">Entry</span>
        </Tooltip>
        <Tooltip content={TOOLTIP.playbookColumn.target} side="bottom">
          <span className="w-full cursor-help text-right">Target</span>
        </Tooltip>
        <Tooltip content={TOOLTIP.playbookColumn.stop} side="bottom">
          <span className="w-full cursor-help text-right">Stop</span>
        </Tooltip>
        <span className="text-right">Distance</span>
        <span>Status</span>
        <Tooltip content={TOOLTIP.playbookColumn.sizing} side="bottom">
          <span className="cursor-help">Sizing</span>
        </Tooltip>
      </div>

      {/* Rule rows */}
      <ul className="divide-edge divide-y">
        {rules.map((rule) => {
          const dm = DIRECTION_META[rule.direction];
          const sm = STATUS_META[rule.status];
          const cm = CONVICTION_META[rule.conviction];
          return (
            <li
              key={rule.id}
              className={`grid ${GRID_COLS} items-center gap-2 px-3 py-2 text-[11px]`}
            >
              <Tooltip content={TOOLTIP.direction[rule.direction]} side="top">
                <span
                  className={`inline-flex cursor-help items-center justify-center gap-1 rounded px-1.5 py-0.5 font-mono font-bold ${dm.className}`}
                >
                  <span aria-hidden="true">{dm.icon}</span>
                  <span>{dm.label}</span>
                </span>
              </Tooltip>
              <span
                className="font-mono"
                style={{ color: 'var(--color-primary)' }}
              >
                {cm !== null && (
                  <Tooltip content={cm.title} side="top">
                    <span
                      className={`mr-1.5 inline-flex cursor-help items-center gap-0.5 rounded px-1 py-0.5 font-mono text-[9px] font-bold ${cm.className}`}
                      aria-label={`Conviction ${cm.label}`}
                    >
                      <span aria-hidden="true">{cm.icon}</span>
                      {cm.label}
                    </span>
                  </Tooltip>
                )}
                {rule.condition}
              </span>
              <span
                className="text-right font-mono font-semibold tabular-nums"
                style={{ color: 'var(--color-primary)' }}
              >
                {fmtEs(rule.entryEs)}
              </span>
              <span
                className="text-right font-mono tabular-nums"
                style={{ color: 'var(--color-secondary)' }}
              >
                {fmtEs(rule.targetEs)}
              </span>
              <span
                className="text-right font-mono tabular-nums"
                style={{ color: 'var(--color-secondary)' }}
              >
                {fmtEs(rule.stopEs)}
              </span>
              <span
                className={`text-right font-mono text-[10px] tabular-nums ${distanceClass(
                  rule.distanceEsPoints,
                )}`}
                aria-label={
                  rule.distanceEsPoints === null
                    ? 'Distance unavailable'
                    : `Distance ${fmtSignedPts(rule.distanceEsPoints)}`
                }
              >
                {fmtSignedPts(rule.distanceEsPoints)}
              </span>
              <Tooltip content={sm.title} side="top">
                <span
                  className={`inline-flex cursor-help items-center justify-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${sm.className}`}
                  aria-label={`Rule status ${sm.label}`}
                >
                  {sm.label}
                </span>
              </Tooltip>
              <span
                className="font-mono text-[10px]"
                style={{ color: 'var(--color-secondary)' }}
              >
                {rule.sizingNote}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

export default PlaybookPanel;
