/**
 * TriggersPanel — Panel 5 of the FuturesGammaPlaybook widget.
 *
 * Renders the five named setups as a status checklist. Each row shows:
 *   - the trigger name,
 *   - a status badge (ACTIVE / ARMED / DISTANT / BLOCKED / RECENTLY_FIRED),
 *   - the signed ES-point distance to arming,
 *   - a plain-English condition summary, and
 *   - the ES price of the keyed level (when one exists).
 *
 * Pure presentational — the hook does all the classification work via
 * `evaluateTriggers`. Memoized so re-renders only fire when the inputs
 * actually change, not on every parent tick.
 *
 * When only one trigger is ACTIVE or ARMED and every other is BLOCKED we
 * float that row to the top so the trader sees the available play first.
 */

import { memo, useMemo } from 'react';
import type {
  EsLevel,
  GexRegime,
  PlaybookFlowSignals,
  SessionPhase,
} from './types';
import {
  evaluateTriggers,
  type TriggerState,
  type TriggerStatus,
} from './triggers';
import { Tooltip } from '../ui/Tooltip';
import { TOOLTIP } from './copy/tooltips';

export interface TriggersPanelProps {
  regime: GexRegime;
  phase: SessionPhase;
  esPrice: number | null;
  levels: EsLevel[];
  /** ES price of the highest-|GEX| strike — charm-drift magnet. */
  esGammaPin?: number | null;
  /**
   * Flow signals — when present, the evaluator suppresses fade/lift
   * triggers during a drift-override to match `rulesForRegime`.
   */
  flowSignals?: PlaybookFlowSignals | null;
}

// ── Presentation metadata ────────────────────────────────────────────

const STATUS_META: Record<
  TriggerStatus,
  { label: string; icon: string; className: string }
> = {
  ACTIVE: {
    label: 'ACTIVE',
    icon: '●',
    className: 'bg-sky-500/20 text-sky-300',
  },
  ARMED: {
    label: 'ARMED',
    icon: '●',
    className: 'bg-amber-500/20 text-amber-300',
  },
  DISTANT: {
    label: 'DISTANT',
    icon: '○',
    className: 'bg-white/5 text-muted',
  },
  BLOCKED: {
    label: 'BLOCKED',
    icon: '⊘',
    className: 'bg-white/5 text-muted opacity-60',
  },
  RECENTLY_FIRED: {
    label: 'RECENTLY FIRED',
    icon: '✕',
    className: 'bg-amber-500/20 text-amber-300',
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
 * Re-order triggers so any single ACTIVE or ARMED row lifts to the top
 * when every other trigger is BLOCKED. Otherwise preserve declaration
 * order so the panel looks the same from tick to tick.
 */
function prioritize(triggers: TriggerState[]): TriggerState[] {
  const actionable = triggers.filter(
    (t) => t.status === 'ACTIVE' || t.status === 'ARMED',
  );
  const blocked = triggers.filter((t) => t.status === 'BLOCKED');
  const others = triggers.length - actionable.length - blocked.length;
  if (actionable.length === 1 && others === 0 && blocked.length > 0) {
    const lifted = actionable[0];
    if (!lifted) return triggers;
    return [lifted, ...triggers.filter((t) => t.id !== lifted.id)];
  }
  return triggers;
}

/** Color the signed distance depending on sign — matches rule distance UX. */
function distanceClass(distance: number | null): string {
  if (distance === null) return 'text-muted';
  if (distance > 0) return 'text-emerald-400';
  if (distance < 0) return 'text-red-400';
  return '';
}

// ── Component ─────────────────────────────────────────────────────────

export const TriggersPanel = memo(function TriggersPanel({
  regime,
  phase,
  esPrice,
  levels,
  esGammaPin,
  flowSignals,
}: TriggersPanelProps) {
  const triggers = useMemo(
    () =>
      prioritize(
        evaluateTriggers({
          regime,
          phase,
          esPrice,
          levels,
          esGammaPin,
          flowSignals,
        }),
      ),
    [regime, phase, esPrice, levels, esGammaPin, flowSignals],
  );

  if (levels.length === 0) {
    return (
      <div
        className="border-edge bg-surface-alt mb-3 rounded-lg border p-4 text-center"
        aria-label="Setup triggers"
      >
        <div
          className="font-mono text-[12px] font-semibold tracking-wider uppercase"
          style={{ color: 'var(--color-tertiary)' }}
        >
          Triggers unavailable
        </div>
        <div
          className="mt-1 font-mono text-[11px]"
          style={{ color: 'var(--color-secondary)' }}
        >
          Awaiting ES levels — no triggers can be evaluated yet.
        </div>
      </div>
    );
  }

  return (
    <div
      className="border-edge bg-surface-alt mb-3 rounded-lg border"
      aria-label="Setup triggers"
    >
      {/* Header row */}
      <div
        className="border-edge grid grid-cols-[140px_140px_90px_1fr_110px] items-center gap-2 border-b px-3 py-1.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
        style={{ color: 'var(--color-tertiary)' }}
      >
        <span>Setup</span>
        <span>Status</span>
        <span className="text-right">Distance</span>
        <span>Condition</span>
        <span className="text-right">Level</span>
      </div>

      {/* Trigger rows */}
      <ul className="divide-edge divide-y">
        {triggers.map((trigger) => {
          const sm = STATUS_META[trigger.status];
          const blocked = trigger.status === 'BLOCKED';
          const nameClass = blocked ? 'line-through opacity-60' : '';
          const conditionClass = blocked ? 'opacity-60' : '';
          return (
            <li
              key={trigger.id}
              className="grid grid-cols-[140px_140px_90px_1fr_110px] items-center gap-2 px-3 py-2 text-[11px]"
            >
              <Tooltip content={TOOLTIP.trigger[trigger.id]} side="top">
                <span
                  className={`cursor-help font-mono font-semibold ${nameClass}`}
                  style={{ color: 'var(--color-primary)' }}
                >
                  {trigger.name}
                </span>
              </Tooltip>
              <Tooltip
                content={
                  blocked && trigger.blockedReason
                    ? trigger.blockedReason
                    : TOOLTIP.triggerStatus[trigger.status]
                }
                side="top"
              >
                <span
                  className={`inline-flex cursor-help items-center justify-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${sm.className}`}
                  aria-label={`Status ${sm.label}`}
                >
                  <span aria-hidden="true">{sm.icon}</span>
                  <span>{sm.label}</span>
                </span>
              </Tooltip>
              <span
                className={`text-right font-mono text-[10px] tabular-nums ${distanceClass(
                  trigger.distanceEsPoints,
                )}`}
                aria-label={
                  trigger.distanceEsPoints === null
                    ? 'Distance unavailable'
                    : `Distance ${fmtSignedPts(trigger.distanceEsPoints)}`
                }
              >
                {fmtSignedPts(trigger.distanceEsPoints)}
              </span>
              <span
                className={`font-mono text-[10px] ${conditionClass}`}
                style={{ color: 'var(--color-secondary)' }}
              >
                {trigger.condition}
              </span>
              <span
                className="flex items-center justify-end gap-1 text-right font-mono text-[11px] tabular-nums"
                style={{ color: 'var(--color-primary)' }}
              >
                {trigger.levelLabel === null ? (
                  <span style={{ color: 'var(--color-tertiary)' }}>—</span>
                ) : (
                  <>
                    <span
                      aria-hidden="true"
                      style={{ color: 'var(--color-tertiary)' }}
                    >
                      {/* BLOCKED triggers still surface the keyed level
                          for context, but we prefix with "Ref:" (short
                          for "reference only") so the trader doesn't
                          misread it as a live, tradeable level. Without
                          this the row looked identical to an actionable
                          reading — seen at 2:50 PM 2026-04-21. */}
                      {blocked ? 'Ref:' : `${trigger.levelLabel}:`}
                    </span>
                    <span
                      aria-label={
                        blocked
                          ? `${trigger.levelLabel} reference at ${fmtEs(
                              trigger.levelEsPrice,
                            )}`
                          : `${trigger.levelLabel} at ${fmtEs(
                              trigger.levelEsPrice,
                            )}`
                      }
                    >
                      {fmtEs(trigger.levelEsPrice)}
                    </span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

export default TriggersPanel;
