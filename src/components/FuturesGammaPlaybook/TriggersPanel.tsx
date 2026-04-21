/**
 * TriggersPanel — Panel 5 of the FuturesGammaPlaybook widget.
 *
 * Renders the five named setups as a status checklist. Each row shows:
 *   - the trigger name,
 *   - a status badge (ACTIVE / IDLE / RECENTLY_FIRED),
 *   - a plain-English condition summary, and
 *   - the ES price of the keyed level (when one exists).
 *
 * Pure presentational — the hook does all the classification work via
 * `evaluateTriggers`. Memoized so re-renders only fire when the inputs
 * actually change, not on every parent tick.
 *
 * Phase 1D.3 note: `RECENTLY_FIRED` is forward-compatible only. The
 * current evaluator never emits it — Phase 1E will add recent-fire
 * tracking once the alerts system lands.
 */

import { memo, useMemo } from 'react';
import type { EsLevel, GexRegime, SessionPhase } from './types';
import { evaluateTriggers, type TriggerStatus } from './triggers';

export interface TriggersPanelProps {
  regime: GexRegime;
  phase: SessionPhase;
  esPrice: number | null;
  levels: EsLevel[];
}

// ── Presentation metadata ────────────────────────────────────────────

const STATUS_META: Record<
  TriggerStatus,
  { label: string; icon: string; className: string; title: string }
> = {
  ACTIVE: {
    label: 'ACTIVE',
    icon: '●',
    className: 'bg-emerald-500/20 text-emerald-300',
    title: 'This trigger is firing right now — conditions met.',
  },
  IDLE: {
    label: 'IDLE',
    icon: '○',
    className: 'bg-white/5 text-muted',
    title: 'Conditions are not met — the trigger is dormant.',
  },
  RECENTLY_FIRED: {
    label: 'RECENTLY FIRED',
    icon: '✕',
    className: 'bg-amber-500/20 text-amber-300',
    title: 'This trigger fired within the last few minutes.',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

function fmtEs(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

// ── Component ─────────────────────────────────────────────────────────

export const TriggersPanel = memo(function TriggersPanel({
  regime,
  phase,
  esPrice,
  levels,
}: TriggersPanelProps) {
  const triggers = useMemo(
    () => evaluateTriggers({ regime, phase, esPrice, levels }),
    [regime, phase, esPrice, levels],
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
      className="border-edge bg-surface-alt mb-3 overflow-hidden rounded-lg border"
      aria-label="Setup triggers"
    >
      {/* Header row */}
      <div
        className="border-edge grid grid-cols-[140px_140px_1fr_110px] items-center gap-2 border-b px-3 py-1.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
        style={{ color: 'var(--color-tertiary)' }}
      >
        <span>Setup</span>
        <span>Status</span>
        <span>Condition</span>
        <span className="text-right">Level</span>
      </div>

      {/* Trigger rows */}
      <ul className="divide-edge divide-y">
        {triggers.map((trigger) => {
          const sm = STATUS_META[trigger.status];
          return (
            <li
              key={trigger.id}
              className="grid grid-cols-[140px_140px_1fr_110px] items-center gap-2 px-3 py-2 text-[11px]"
            >
              <span
                className="font-mono font-semibold"
                style={{ color: 'var(--color-primary)' }}
              >
                {trigger.name}
              </span>
              <span
                className={`inline-flex items-center justify-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${sm.className}`}
                title={sm.title}
                aria-label={`Status ${sm.label}`}
              >
                <span aria-hidden="true">{sm.icon}</span>
                <span>{sm.label}</span>
              </span>
              <span
                className="font-mono text-[10px]"
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
                      {trigger.levelLabel}:
                    </span>
                    <span
                      aria-label={`${trigger.levelLabel} at ${fmtEs(
                        trigger.levelEsPrice,
                      )}`}
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
